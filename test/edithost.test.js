'use strict';
// Host helpers: lsof parsing, the sqlite3 checkpoint call (with a fake exec), and the empty database for CSV import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { parseLsof, checkpoint, emptyDatabase, whoHasOpen } = require('../src/editHost');

test('parseLsof lists other processes once, never this one', () => {
  const out = `p${process.pid}\ncCode Helper\np4242\ncpython3\np4242\ncpython3\np77\ncDBeaver\n`;
  assert.deepEqual(parseLsof(out, process.pid), [{ pid: 4242, command: 'python3' }, { pid: 77, command: 'DBeaver' }]);
  assert.deepEqual(parseLsof('', process.pid), []);
});

test('whoHasOpen: empty when lsof finds nothing or fails', async () => {
  assert.deepEqual(await whoHasOpen('/x.db', (cmd, args, o, cb) => cb(new Error('exit 1'), '')), []);
  const r = await whoHasOpen('/x.db', (cmd, args, o, cb) => { assert.equal(cmd, 'lsof'); assert.deepEqual(args.slice(-2), ['/x.db', '/x.db-wal']); cb(null, 'p99\ncsqlite3\n'); });
  assert.deepEqual(r, process.platform === 'win32' ? [] : [{ pid: 99, command: 'sqlite3' }]);
});

test('checkpoint: ok, busy, missing tool', async () => {
  let r = await checkpoint('/x.db', (cmd, args, o, cb) => { assert.deepEqual(args, ['/x.db', 'PRAGMA wal_checkpoint(TRUNCATE);']); cb(null, '0|0|0\n', ''); });
  assert.equal(r.ok, true);
  r = await checkpoint('/x.db', (cmd, args, o, cb) => cb(null, '1|5|2\n', ''));
  assert.match(r.message, /busy/);
  r = await checkpoint('/x.db', (cmd, args, o, cb) => cb(Object.assign(new Error('nope'), { code: 'ENOENT' }), '', ''));
  assert.equal(r.missing, true);
});

test('emptyDatabase is a valid SQLite file that takes a table', async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database(emptyDatabase());
  assert.deepEqual(db.exec('PRAGMA integrity_check')[0].values, [['ok']]);
  db.run('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
  assert.deepEqual(db.exec('SELECT * FROM t')[0].values, [[1]]);
});
