'use strict';
// Worker thread in the extension host: loads sql.js (wasm) and one database, then answers messages.
// "reload" opens a fresh copy of the file (and its -wal) and shows the same table, sort and filters.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('./core/session');

let session = null;
let SQL = null;
const post = m => parentPort.postMessage(m);

function readSource(source) {
  if (!source.path) return { bytes: source.bytes, wal: source.wal || null };
  const bytes = fs.readFileSync(source.path);
  let wal = null;
  try { wal = fs.readFileSync(source.path + '-wal'); } catch { /* no WAL file */ }
  return { bytes, wal };
}

async function load(msg) {
  if (!SQL) SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(__dirname, 'sql-wasm.wasm')) });
  const t0 = Date.now();
  const { bytes, wal } = readSource(msg.source);
  const s = openSession(SQL, bytes, { ...(msg.options || {}), wal });
  return { s, ms: Date.now() - t0 };
}

parentPort.on('message', async msg => {
  if (msg.type === 'open') {
    try {
      const { s, ms } = await load(msg);
      session = s;
      post({ type: 'opened', ms, wal: s.wal });
      post(session.objectsMessage());
    } catch (e) {
      post({ type: 'error', message: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'reload') {
    // The old copy stays on screen until the new one has opened, so a failed reload never blanks the view.
    let next;
    try { next = (await load(msg)); } catch (e) {
      post({ type: 'reloadFailed', message: e.message || String(e) });
      return;
    }
    const state = session ? session.state() : null;
    if (session) session.close();
    session = next.s;
    post({ type: 'reloaded', ms: next.ms, wal: session.wal, reason: msg.reason || 'file' });
    post(session.objectsMessage());
    for (const out of session.restore(state)) post(out);
    return;
  }
  if (msg.type === 'close') { if (session) session.close(); session = null; return; }
  if (!session) return;
  for (const out of session.handle(msg)) post(out);
});
