'use strict';
// Safe write-back of an edited database image. Used by the worker for files on this computer.
//
// Save never writes when:
//   - the file changed since it was loaded (size, modified time or the 100-byte header differ),
//   - the -wal file holds committed frames (SQLite would lay them over the new file and mix two versions),
//   - a hot -journal exists (another process is inside a write or crashed in one),
//   - the file or its folder is read-only.
// Otherwise: a timestamped backup copy, the new image into a temp file in the same folder, fsync, rename over the
// original, fsync the folder. A crash at any point leaves either the old file or the new one, never half of each.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readWal } = require('./wal');

const HEADER = 100;
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

/** What the file looked like when it was read: size, mtime and the first 100 bytes. */
function fingerprint(file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(HEADER);
    const n = fs.readSync(fd, b, 0, HEADER, 0);
    return { size: st.size, mtimeMs: st.mtimeMs, header: b.subarray(0, n).toString('hex') };
  } finally { fs.closeSync(fd); }
}

function sameFingerprint(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.header === b.header;
}

/** Committed frames in the -wal file next to file (0 when there is no -wal, or it is empty or stale). */
function walFrames(file) {
  let wal;
  try { wal = fs.readFileSync(file + '-wal'); } catch { return 0; }
  const r = readWal(wal);
  return r.ok ? r.commits : 0;
}

/** True when a -journal next to file starts with the journal magic: a write is in progress or was cut off. */
function hotJournal(file) {
  let fd;
  try { fd = fs.openSync(file + '-journal', 'r'); } catch { return false; }
  try {
    const b = Buffer.alloc(8);
    const n = fs.readSync(fd, b, 0, 8, 0);
    return n === 8 && b.equals(JOURNAL_MAGIC);
  } catch { return false; } finally { fs.closeSync(fd); }
}

function canWrite(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * Checks before editing starts and again right before a save. baseline: fingerprint() taken when the bytes were read.
 * Returns { ok, code, message }. code: changed | missing | wal | journal | readonly | dirReadonly.
 */
function checkWritable(file, baseline, opts = {}) {
  let now;
  try { now = fingerprint(file); } catch { return { ok: false, code: 'missing', message: 'The file is gone or cannot be read any more. Nothing was written.' }; }
  if (baseline && !sameFingerprint(baseline, now)) {
    return { ok: false, code: 'changed', message: 'The file changed on disk after it was loaded (another program wrote to it). Nothing was written. Reload to see the new version, then make your changes again.' };
  }
  const frames = walFrames(file);
  if (frames > 0) {
    return { ok: false, code: 'wal', frames, message: `The -wal file next to it holds ${frames} committed transaction${frames === 1 ? '' : 's'} that are not in the main file yet. Writing now could mix two versions. Choose "Checkpoint and reload", or close the app that uses the database, then try again.` };
  }
  if (hotJournal(file)) {
    return { ok: false, code: 'journal', message: 'A -journal file shows that another program is writing to this database, or crashed while writing. Open it once in that program or the sqlite3 tool so SQLite can finish or roll back, then reload.' };
  }
  if (!canWrite(file)) return { ok: false, code: 'readonly', message: 'The file is read-only (its permissions do not allow writing). Nothing was written.' };
  if (!opts.skipDir && !canWrite(path.dirname(file))) return { ok: false, code: 'dirReadonly', message: 'The folder is read-only, so a safe save (temp file, then rename) is not possible. Nothing was written.' };
  return { ok: true };
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Where the backup copy goes. location: 'nextToFile' (default) or 'homeFolder' (~/.zovo-sqlite-backups). */
function backupPath(file, location, now = new Date(), home = os.homedir()) {
  const base = path.basename(file);
  const dir = location === 'homeFolder' ? path.join(home, '.zovo-sqlite-backups') : path.dirname(file);
  let p = path.join(dir, `${base}.${stamp(now)}.bak`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}.${stamp(now)}-${i}.bak`);
  return p;
}

function fsyncDir(dir) {
  // Folders cannot be opened for fsync on Windows; the rename is already durable enough there.
  if (process.platform === 'win32') return;
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/**
 * Write bytes over file safely. Returns { backup, tempUsed, ms }. Throws an Error with a message ready to show.
 * opts: { baseline, backup: 'nextToFile' | 'homeFolder', now }
 */
function safeWrite(file, bytes, opts = {}) {
  const t0 = Date.now();
  const check = checkWritable(file, opts.baseline);
  if (!check.ok) { const e = new Error(check.message); e.code = check.code; throw e; }
  const mode = fs.statSync(file).mode & 0o7777;
  const dir = path.dirname(file);
  // 1. Backup copy of the file as it is on disk now (it matches the baseline).
  const backup = backupPath(file, opts.backup, opts.now);
  try {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    const err = new Error(`The backup copy could not be written (${e.code || e.message}), so the database was not saved. Free some disk space or pick another backup folder (setting sqliteTableViewer.backupLocation).`);
    err.code = 'backup';
    throw err;
  }
  // 2. New image into a temp file in the same folder, flushed to disk.
  const tmp = path.join(dir, `.${path.basename(file)}.zovo-save-${process.pid}-${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode || 0o644);
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, Math.min(16 * 1024 * 1024, bytes.length - off));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // 3. Last look: the file must still be what was loaded. Then swap.
    const again = checkWritable(file, opts.baseline);
    if (!again.ok) { const e = new Error(again.message); e.code = again.code; throw e; }
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
    if (e.code && ['changed', 'wal', 'journal', 'readonly', 'dirReadonly', 'missing'].includes(e.code)) throw e;
    const err = new Error(`The database was not saved: ${e.code === 'ENOSPC' ? 'the disk is full' : e.message}. The original file is unchanged, and the backup is ${backup}.`);
    err.code = 'io';
    throw err;
  }
  fsyncDir(dir);
  return { backup, ms: Date.now() - t0 };
}

module.exports = { fingerprint, sameFingerprint, walFrames, hotJournal, checkWritable, backupPath, safeWrite, JOURNAL_MAGIC };
