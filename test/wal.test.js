'use strict';
// WAL frames applied to the in-memory copy, and reload keeping the view. Uses real WAL files made by Python's sqlite3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('../src/core/session');
const { readWal, applyWal } = require('../src/core/wal');
const M = require('../src/webview/math');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-wal-'));
// live.db: WAL mode, 3 commits left in the -wal (a table made only in the WAL, 40 rows, an update),
// plus a torn last frame. The writer is still open when the files are copied, like an app that is running.
const PY = String.raw`
import sqlite3, shutil, sys, os
d = sys.argv[1]
p = os.path.join(d, 'src.db')
db = sqlite3.connect(p, isolation_level=None)
db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE base(id INTEGER PRIMARY KEY, v TEXT)')
db.executemany('INSERT INTO base(v) VALUES (?)', [('b%d' % i,) for i in range(10)])
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
db.execute('CREATE TABLE fresh(id INTEGER PRIMARY KEY, note TEXT)')
db.execute('BEGIN'); db.executemany('INSERT INTO fresh(note) VALUES (?)', [('n%d' % i,) for i in range(40)]); db.execute('COMMIT')
db.execute("UPDATE base SET v = 'changed' WHERE id = 1")
shutil.copy(p, os.path.join(d, 'live.db')); shutil.copy(p + '-wal', os.path.join(d, 'live.db-wal'))
db.close()
w = open(os.path.join(d, 'live.db-wal'), 'rb').read()
open(os.path.join(d, 'torn.db-wal'), 'wb').write(w + w[32:32 + 24 + 100])
`;
execFileSync('python3', ['-I', '-c', PY, dir]);
const read = f => fs.readFileSync(path.join(dir, f));
let SQL;
test.before(async () => { SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) }); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('readWal finds the committed frames and the database size', () => {
  const r = readWal(read('live.db-wal'));
  assert.ok(r.ok);
  assert.strictEqual(r.commits, 3);
  assert.ok(r.dbPages >= 3);
  assert.strictEqual(r.pageSize, 4096);
});

test('without the -wal the new table is missing; with it the rows and the update show', () => {
  const plain = openSession(SQL, read('live.db'));
  assert.deepStrictEqual(plain.objects.tables.map(t => t.name), ['base']);
  const s = openSession(SQL, read('live.db'), { wal: read('live.db-wal') });
  assert.deepStrictEqual(s.wal, { present: true, applied: true, commits: 3, pages: s.wal.pages, reason: null });
  assert.deepStrictEqual(s.objects.tables.map(t => [t.name, t.rows]), [['base', 10], ['fresh', 40]]);
  assert.strictEqual(s.one("SELECT v FROM base WHERE id = 1"), 'changed');
  assert.strictEqual(s.one('PRAGMA integrity_check'), 'ok');
});

test('a torn frame at the end is ignored, never a blank page', () => {
  const s = openSession(SQL, read('live.db'), { wal: read('torn.db-wal') });
  assert.strictEqual(s.wal.commits, 3);
  assert.strictEqual(s.objects.tables.length, 2);
});

test('garbage or a mismatched -wal falls back to the main file with a warning', () => {
  const bad = Buffer.from('not a wal file at all, just some text that is long enough');
  const s = openSession(SQL, read('live.db'), { wal: bad });
  assert.strictEqual(s.wal.applied, false);
  assert.deepStrictEqual(s.objects.tables.map(t => t.name), ['base']);
  assert.match(M.walNote(s.wal, 'live.db').text, /could not be read/);
  const w = Buffer.from(read('live.db-wal'));
  w[8] = 0; w[9] = 0; w[10] = 2; w[11] = 0; // page size 512, header checksum now wrong
  assert.strictEqual(applyWal(read('live.db'), w).applied, false);
  assert.strictEqual(M.walNote({ present: true, applied: false, reason: 'empty' }, 'x.db'), null);
});

test('the file bytes are never changed', () => {
  const db = read('live.db'); const before = Buffer.from(db);
  const wal = read('live.db-wal'); const wb = Buffer.from(wal);
  openSession(SQL, db, { wal });
  assert.ok(before.equals(db) && wb.equals(wal));
});

test('the banner text counts the transactions', () => {
  assert.match(M.walNote({ present: true, applied: true, commits: 3 }, 'live.db').text, /^Includes 3 committed transactions from live\.db-wal/);
  assert.match(M.walNote({ present: true, applied: true, commits: 1 }, 'a.db').text, /1 committed transaction from a\.db-wal that is not/);
  assert.strictEqual(M.walNote({ present: false }, 'a.db'), null);
});

test('restore keeps the table, sort and filters after a reload', () => {
  const a = openSession(SQL, read('live.db'), { wal: read('live.db-wal') });
  a.handle({ type: 'openTable', name: 'fresh' });
  a.handle({ type: 'sort', col: 0, dir: 'desc' });
  a.handle({ type: 'filter', global: '', columns: { 1: 'n1' } });
  const st = a.state();
  const b = openSession(SQL, read('live.db'), { wal: read('live.db-wal') });
  const out = b.restore(st);
  const meta = out.find(m => m.type === 'meta');
  assert.strictEqual(meta.keep, true);
  assert.strictEqual(meta.source.name, 'fresh');
  assert.deepStrictEqual(meta.sort, { col: 0, dir: 'desc' });
  assert.strictEqual(meta.viewCount, 11); // n1, n10..n19
  const first = b.handle({ type: 'getRows', reqId: 1, start: 0, count: 1 })[0].rows[0];
  assert.strictEqual(first.cells[1], 'n19');
});

test('restore of a query re-runs it; a table that is gone gives no view and no error', () => {
  const a = openSession(SQL, read('live.db'), { wal: read('live.db-wal') });
  a.handle({ type: 'runSql', sql: 'SELECT COUNT(*) AS n FROM fresh' });
  const b = openSession(SQL, read('live.db'), { wal: read('live.db-wal') });
  const meta = b.restore(a.state()).find(m => m.type === 'meta');
  assert.strictEqual(meta.source.kind, 'query');
  assert.strictEqual(meta.viewCount, 1);
  const c = openSession(SQL, read('live.db'));
  assert.deepStrictEqual(c.restore({ kind: 'table', name: 'fresh', sort: null, filters: null }), []);
});
