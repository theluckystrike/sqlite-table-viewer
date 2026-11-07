'use strict';
// Applies the committed frames of a SQLite write-ahead log (the "-wal" file) to a copy of the
// database bytes, the same way SQLite does when it reads a WAL database. Pure: no fs, no sql.js.
// Format: https://www.sqlite.org/fileformat2.html#walformat
// Only frames up to the last valid commit frame are used. A frame is valid when its salts match the
// WAL header and the running checksum matches, so a half-written frame at the end is ignored.

const WAL_HEADER = 32;
const FRAME_HEADER = 24;

function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

/** Running WAL checksum over bytes [start, end) (a multiple of 8), continuing from s = [s0, s1]. */
function checksum(b, start, end, s, bigEndian) {
  let s0 = s[0], s1 = s[1];
  for (let i = start; i < end; i += 8) {
    const x0 = bigEndian ? u32(b, i) : ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
    const x1 = bigEndian ? u32(b, i + 4) : ((b[i + 7] << 24) | (b[i + 6] << 16) | (b[i + 5] << 8) | b[i + 4]) >>> 0;
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

/** Page size from a database header (bytes 16-17, where 1 means 65536), or 0. */
function dbPageSize(db) {
  if (!db || db.length < 100) return 0;
  const v = (db[16] << 8) | db[17];
  return v === 1 ? 65536 : v;
}

/**
 * Read the committed frames of a WAL file.
 * @returns {{ok:boolean, reason?:string, pageSize?:number, frames?:number, commits?:number, dbPages?:number, pages?:Map<number, number>}}
 *   pages maps a page number to the byte offset of its newest committed copy inside wal.
 */
function readWal(wal) {
  if (!wal || wal.length < WAL_HEADER) return { ok: false, reason: 'empty' };
  const magic = u32(wal, 0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { ok: false, reason: 'not a WAL file' };
  const bigEndian = (magic & 1) === 1;
  const pageSize = u32(wal, 8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return { ok: false, reason: 'bad page size' };
  let s = checksum(wal, 0, 24, [0, 0], bigEndian);
  if (s[0] !== u32(wal, 24) || s[1] !== u32(wal, 28)) return { ok: false, reason: 'bad header checksum' };
  const salt1 = u32(wal, 16), salt2 = u32(wal, 20);
  const frameSize = FRAME_HEADER + pageSize;
  const pending = new Map();
  const pages = new Map();
  let frames = 0, commits = 0, dbPages = 0;
  for (let off = WAL_HEADER; off + frameSize <= wal.length; off += frameSize) {
    if (u32(wal, off + 8) !== salt1 || u32(wal, off + 12) !== salt2) break;
    s = checksum(wal, off, off + 8, s, bigEndian);
    s = checksum(wal, off + FRAME_HEADER, off + frameSize, s, bigEndian);
    if (s[0] !== u32(wal, off + 16) || s[1] !== u32(wal, off + 20)) break;
    const pgno = u32(wal, off);
    if (pgno === 0) break;
    pending.set(pgno, off + FRAME_HEADER);
    frames++;
    const commitSize = u32(wal, off + 4);
    if (commitSize > 0) {
      for (const [p, o] of pending) pages.set(p, o);
      pending.clear();
      dbPages = commitSize;
      commits++;
    }
  }
  return { ok: true, pageSize, frames, commits, dbPages, pages };
}

/**
 * Database bytes with the committed WAL frames applied.
 * @param {Uint8Array} db main database file (may be empty when the WAL holds page 1)
 * @param {Uint8Array} wal the -wal file
 * @returns {{bytes:Uint8Array, applied:boolean, commits:number, pages:number, reason?:string}}
 *   applied is false (and bytes is db) when the WAL is empty, from an older checkpoint, or unusable.
 */
function applyWal(db, wal) {
  const r = readWal(wal);
  if (!r.ok) return { bytes: db, applied: false, commits: 0, pages: 0, reason: r.reason };
  if (!r.commits) return { bytes: db, applied: false, commits: 0, pages: 0, reason: 'no committed changes' };
  const ps = dbPageSize(db);
  if (db.length && ps && ps !== r.pageSize) return { bytes: db, applied: false, commits: 0, pages: 0, reason: 'page size differs from the database' };
  if (!db.length && !r.pages.has(1)) return { bytes: db, applied: false, commits: 0, pages: 0, reason: 'no database header' };
  const size = r.dbPages * r.pageSize;
  const out = new Uint8Array(size);
  out.set(db.subarray(0, Math.min(db.length, size)));
  for (const [pgno, off] of r.pages) {
    if (pgno > r.dbPages) continue;
    out.set(wal.subarray(off, off + r.pageSize), (pgno - 1) * r.pageSize);
  }
  return { bytes: out, applied: true, commits: r.commits, pages: r.pages.size };
}

module.exports = { readWal, applyWal, checksum, dbPageSize };
