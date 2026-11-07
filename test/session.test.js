'use strict';
// Runs the real Session on sql.js against the generated sample databases (scripts/make-samples.py).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('../src/core/session');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-test-'));
execFileSync('python3', ['-I', path.join(__dirname, '../scripts/make-samples.py'), dir]);
const read = f => fs.readFileSync(path.join(dir, f));
let SQL;
test.before(async () => { SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) }); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const last = a => a[a.length - 1];

test('store.db lists tables, views, indexes and triggers with row counts', () => {
  const s = openSession(SQL, read('store.db'));
  const o = s.objectsMessage();
  assert.deepStrictEqual(o.tables.map(t => [t.name, t.rows]), [['customers', 8000], ['order_items', 25000], ['orders', 15000], ['products', 2000]]);
  assert.strictEqual(o.tables.reduce((a, t) => a + t.rows, 0), 50000);
  assert.deepStrictEqual(o.views.map(v => v.name), ['order_totals', 'top_products']);
  assert.strictEqual(o.indexes.length, 3);
  assert.strictEqual(o.triggers[0].name, 'trg_stock');
  assert.strictEqual(o.tables.find(t => t.name === 'order_items').withoutRowid, true);
});

test('paging, sort and filters', () => {
  const s = openSession(SQL, read('store.db'));
  const meta = s.handle({ type: 'openTable', name: 'orders' })[0];
  assert.strictEqual(meta.viewCount, 15000);
  const page = s.handle({ type: 'getRows', reqId: 1, start: 14990, count: 200 })[0];
  assert.strictEqual(page.rows.length, 10);
  assert.strictEqual(page.rows[0].id, 14990);
  const v = s.handle({ type: 'filter', global: '', columns: { 2: '=paid' } })[0];
  assert.ok(v.viewCount > 2000 && v.viewCount < 4000);
  s.handle({ type: 'sort', col: 4, dir: 'desc' });
  const rows = s.handle({ type: 'getRows', reqId: 2, start: 0, count: 50 })[0].rows;
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].cells[4] >= rows[i].cells[4]);
  assert.ok(rows.every(r => r.cells[2] === 'paid'));
  const inj = s.handle({ type: 'filter', global: "' OR 1=1 --", columns: {} })[0];
  assert.strictEqual(inj.viewCount, 0);
  const wr = s.handle({ type: 'openTable', name: 'order_items' })[0];
  assert.strictEqual(wr.viewCount, 25000);
  s.handle({ type: 'sort', col: 2, dir: 'asc' });
  assert.strictEqual(s.handle({ type: 'getRows', reqId: 3, start: 0, count: 1 })[0].rows[0].cells[2], 1);
});

test('SQL box: read-only statements run, writes are refused, the file is untouched', () => {
  const bytes = read('store.db');
  const before = Buffer.from(bytes);
  const s = openSession(SQL, bytes);
  const out = s.handle({ type: 'runSql', sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status -- note" });
  assert.strictEqual(out[0].viewCount, 5);
  assert.strictEqual(last(out).type, 'sqlDone');
  s.handle({ type: 'sort', col: 1, dir: 'desc' });
  const r = s.handle({ type: 'getRows', reqId: 1, start: 0, count: 5 })[0].rows;
  assert.ok(r[0].cells[1] >= r[4].cells[1]);
  assert.strictEqual(s.handle({ type: 'runSql', sql: 'PRAGMA table_info(orders)' })[0].canFilter, false);
  assert.strictEqual(s.handle({ type: 'runSql', sql: 'DELETE FROM orders' })[0].type, 'sqlError');
  assert.throws(() => s.db.run("INSERT INTO orders (customer_id, ordered_at) VALUES (1, 'x')"), /readonly/);
  assert.match(s.handle({ type: 'runSql', sql: 'SELECT * FROM nope' })[0].message, /no such table/);
  assert.ok(bytes.equals(before));
  assert.ok(read('store.db').equals(before));
});

test('cells: JSON, PNG and float32 vector from types.sqlite', () => {
  const s = openSession(SQL, read('types.sqlite'));
  s.handle({ type: 'openTable', name: 'samples' });
  const grid = s.handle({ type: 'getRows', reqId: 1, start: 0, count: 12 })[0].rows;
  assert.deepStrictEqual(grid[1].cells[2], { i: '9007199254740993' });
  assert.deepStrictEqual(grid[8].cells[6], { b: grid[8].cells[6].b, k: 'png' });
  assert.strictEqual(s.handle({ type: 'cell', row: 6, col: 5 })[0].value.json, true);
  assert.ok(s.handle({ type: 'cell', row: 8, col: 6 })[0].value.image.startsWith('data:image/png;base64,'));
  const vec = s.handle({ type: 'cell', row: 9, col: 7 })[0].value.vectors[0];
  assert.strictEqual(vec.dim, 384);
  assert.ok(Math.abs(vec.norm - 1) < 1e-4);
  const ins = s.handle({ type: 'copy', format: 'insert', sel: { r0: 8, r1: 8, c0: 0, c1: 0, header: true } })[0];
  assert.match(ins.text, /^INSERT INTO "samples" .* X'89504e47/);
  const exp = s.handle({ type: 'export', format: 'json' })[0];
  assert.strictEqual(JSON.parse(exp.text).length, 12);
});

test('schema tab data: columns, keys and foreign keys', () => {
  const s = openSession(SQL, read('store.db'));
  const sc = s.handle({ type: 'schema', name: 'orders' })[0];
  assert.match(sc.sql, /^CREATE TABLE orders/);
  assert.deepStrictEqual(sc.columns.map(c => c.name), ['id', 'customer_id', 'status', 'ordered_at', 'total_cents']);
  assert.strictEqual(sc.columns[2].dflt, "'new'");
  assert.strictEqual(sc.foreignKeys[0].table, 'customers');
  assert.strictEqual(sc.indexes.length, 2);
  assert.strictEqual(s.handle({ type: 'schema', name: 'trg_stock' })[0].objectType, 'trigger');
});

test('empty, WAL, corrupt, encrypted and text files', () => {
  assert.strictEqual(openSession(SQL, read('empty.db')).objectsMessage().tables.length, 0);
  const wal = openSession(SQL, read('wal-mode.db'));
  assert.strictEqual(wal.objectsMessage().tables[0].rows, 100); // the 25 rows in the -wal file are not seen
  assert.ok(fs.statSync(path.join(dir, 'wal-mode.db-wal')).size > 0);
  const withWal = openSession(SQL, read('wal-mode.db'), { wal: read('wal-mode.db-wal') });
  assert.strictEqual(withWal.objectsMessage().tables[0].rows, 125); // the worker reads the -wal too
  assert.strictEqual(withWal.wal.applied, true);
  assert.throws(() => openSession(SQL, read('corrupt.db')), /damaged/);
  assert.throws(() => openSession(SQL, read('encrypted.db')), /encrypted/);
  assert.throws(() => openSession(SQL, read('not-sqlite.db')), /plain text/);
});
