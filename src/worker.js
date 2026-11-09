'use strict';
// Worker thread in the extension host: loads sql.js (wasm) and one database, then answers messages.
// "reload" opens a fresh copy of the file (and its -wal) and shows the same table, sort and filters.
// Editing mode stages changes in memory; "save" writes them with writeback.safeWrite (backup, temp file, rename).
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('./core/session');
const W = require('./core/writeback');
const I = require('./core/importer');

let session = null;
let SQL = null;
let filePath = null;   // local file, or null for other file systems (read-only there)
let baseline = null;   // fingerprint of the file when its bytes were read
let headerModes = null; // original bytes 18-19 (2 = WAL mode)
let importCancel = false;
const post = m => parentPort.postMessage(m);

function readSource(source) {
  if (!source.path) return { bytes: source.bytes, wal: source.wal || null, fp: null };
  // The fingerprint before and after the read must match, or the file was changing while it was read.
  let before = null;
  try { before = W.fingerprint(source.path); } catch { before = null; }
  const bytes = fs.readFileSync(source.path);
  let wal = null;
  try { wal = fs.readFileSync(source.path + '-wal'); } catch { /* no WAL file */ }
  let after = null;
  try { after = W.fingerprint(source.path); } catch { after = null; }
  return { bytes, wal, fp: W.sameFingerprint(before, after) ? after : null };
}

async function load(msg) {
  if (!SQL) SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(__dirname, 'sql-wasm.wasm')) });
  const t0 = Date.now();
  const { bytes, wal, fp } = readSource(msg.source);
  const modes = bytes.length >= 100 ? [bytes[18], bytes[19]] : null;
  const s = openSession(SQL, bytes, { ...(msg.options || {}), wal });
  return { s, ms: Date.now() - t0, fp, modes };
}

function adopt(next, source) {
  session = next.s;
  filePath = source.path || null;
  baseline = next.fp;
  headerModes = next.modes;
}

function enableEditing(msg) {
  if (!filePath) return [{ type: 'editRefused', message: 'Editing works for database files on this computer. This one is on a remote or virtual file system, so it stays read-only.' }];
  if (!baseline) return [{ type: 'editRefused', message: 'The file was changing while it was read. Reload, then enable editing.' }];
  const check = W.checkWritable(filePath, baseline);
  if (!check.ok) return [{ type: 'editRefused', code: check.code, message: check.message }];
  return session.enableEditing(msg.options || {});
}

function save(msg) {
  if (!session || !session.edit) return [{ type: 'saveFailed', message: 'Nothing to save.' }];
  if (!filePath) return [{ type: 'saveFailed', message: 'This file system is read-only here.' }];
  const t0 = Date.now();
  // Look at the file before touching the transaction, so a refused save keeps every change undoable.
  const pre = W.checkWritable(filePath, baseline);
  if (!pre.ok) return [{ type: 'saveFailed', code: pre.code, message: pre.message }, session.pendingMessage()];
  const img = session.buildImage(headerModes);
  if (!img.ok) return [{ type: 'saveFailed', code: img.code, message: img.message }, session.pendingMessage()];
  let res;
  try {
    res = W.safeWrite(filePath, img.bytes, { baseline, backup: msg.backup });
  } catch (e) {
    return [{ type: 'saveFailed', code: e.code, message: e.message }, session.pendingMessage()];
  }
  baseline = W.fingerprint(filePath);
  const changes = session.edit.pending.length;
  session.markSaved(img.bytes.length);
  return [
    { type: 'saved', backup: res.backup, bytes: img.bytes.length, changes, ms: Date.now() - t0, fingerprint: baseline },
    session.pendingMessage(),
    session.objectsMessage(),
  ];
}

async function importRun(msg) {
  importCancel = false;
  post({ type: 'importProgress', rows: 0, bytes: 0, size: 0, start: true });
  try {
    const r = await I.runImport(session, msg.options, p => post({ type: 'importProgress', ...p }), () => importCancel);
    post({ type: 'importDone', ok: true, ...r });
    for (const out of session.afterChange(true)) post(out);
    if (msg.options.mode === 'new' || (session.source && session.source.name !== r.table)) for (const out of session.openTable(r.table)) post(out);
  } catch (e) {
    post({ type: 'importDone', ok: false, cancelled: !!e.cancelled, message: e.message || String(e) });
    post(session.pendingMessage());
  }
}

parentPort.on('message', async msg => {
  if (msg.type === 'open') {
    try {
      const next = await load(msg);
      adopt(next, msg.source);
      post({ type: 'opened', ms: next.ms, wal: session.wal });
      post(session.objectsMessage());
    } catch (e) {
      post({ type: 'error', message: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'reload') {
    if (session && session.edit) { post({ type: 'reloadFailed', message: 'Editing is on. Save or discard your changes, then reload.', editing: true }); return; }
    // The old copy stays on screen until the new one has opened, so a failed reload never blanks the view.
    let next;
    try { next = (await load(msg)); } catch (e) {
      post({ type: 'reloadFailed', message: e.message || String(e) });
      return;
    }
    const state = session ? session.state() : null;
    if (session) session.close();
    adopt(next, msg.source);
    post({ type: 'reloaded', ms: next.ms, wal: session.wal, reason: msg.reason || 'file' });
    post(session.objectsMessage());
    for (const out of session.restore(state)) post(out);
    post(session.pendingMessage());
    return;
  }
  if (msg.type === 'close') { if (session) session.close(); session = null; return; }
  if (!session) return;
  try {
    switch (msg.type) {
      case 'enableEditing': for (const out of enableEditing(msg)) post(out); return;
      case 'save': for (const out of save(msg)) post(out); return;
      case 'importPreview':
        try { post({ type: 'importPreview', ...I.previewCsv(msg.file, msg.options || {}) }); } catch (e) { post({ type: 'importDone', ok: false, message: e.message || String(e) }); }
        return;
      case 'importRun': await importRun(msg); return;
      case 'importCancel': importCancel = true; return;
      case 'blobOut': {
        const r = session.rawRows(msg.row, 1, [msg.col])[0];
        post({ type: 'blobOut', reqId: msg.reqId, bytes: r && r[0] instanceof Uint8Array ? r[0] : null });
        return;
      }
      default:
        for (const out of session.handle(msg)) post(out);
    }
  } catch (e) {
    post({ type: 'error', message: e.message || String(e), transient: true });
  }
});
