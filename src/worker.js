'use strict';
// Worker thread in the extension host: loads sql.js (wasm) and one database, then answers messages.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('./core/session');

let session = null;
const post = m => parentPort.postMessage(m);

parentPort.on('message', async msg => {
  if (msg.type === 'open') {
    try {
      const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(__dirname, 'sql-wasm.wasm')) });
      const t0 = Date.now();
      const bytes = msg.source.path ? fs.readFileSync(msg.source.path) : msg.source.bytes;
      session = openSession(SQL, bytes, msg.options || {});
      post({ type: 'opened', ms: Date.now() - t0 });
      post(session.objectsMessage());
    } catch (e) {
      post({ type: 'error', message: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'close') { if (session) session.close(); session = null; return; }
  if (!session) return;
  for (const out of session.handle(msg)) post(out);
});
