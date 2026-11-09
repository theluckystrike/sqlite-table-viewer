'use strict';
// Editing mode on the real Session (sql.js), safe write-back on real files and CSV import, including a 1M-row file.
// Files go to ~/sqlite-editor-work/test-<pid> (large fixtures stay out of the temp folder) and are deleted at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const { openSession } = require('../src/core/session');
const W = require('../src/core/writeback');
const I = require('../src/core/importer');

const work = path.join(os.homedir(), 'sqlite-editor-work', `test-${process.pid}`);
fs.mkdirSync(work, { recursive: true });
let SQL;
test.before(async () => { SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) }); });
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

const hasSqlite3 = (() => { try { execFileSync('sqlite3', ['-version']); return true; } catch { return false; } })();
const cli = (file, sql) => execFileSync('sqlite3', [file, sql]).toString().trim();
const types = out => out.map(m => m.type);
const errors = out => out.filter(m => /error/i.test(m.type)).map(m => m.message);
const one = (s, q) => { const v = s['one'](q); return typeof v === 'bigint' ? Number(v) : v; };

function makeDb(name, sql) {
  const d = new SQL.Database();
  d.run(sql);
  const f = path.join(work, name);
  fs.writeFileSync(f, d.export());
  d.close();
  return f;
}
function open(file, opts = {}) {
  const bytes = fs.readFileSync(file);
  const s = openSession(SQL, bytes, { fileSize: bytes.length, ...opts });
  return s;
}

const SHOP = `
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL CHECK (price > 0), sku TEXT UNIQUE, total REAL GENERATED ALWAYS AS (price * 2) VIRTUAL);
INSERT INTO products (name, price, sku) VALUES ('pen', 1.5, 'P1'), ('ink', 4, 'P2'), ('pad', 2.25, 'P3');
CREATE TABLE kv (k TEXT PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO kv VALUES ('a', 1), ('b', 2);
CREATE VIEW cheap AS SELECT * FROM products WHERE price < 3;
CREATE TABLE parent (id INTEGER PRIMARY KEY);
INSERT INTO parent VALUES (1), (2);
CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
INSERT INTO child VALUES (1, 1);
`;

test('opens read-only: writes are refused until editing is on', () => {
  const s = open(makeDb('ro.db', SHOP));
  s.openTable('products');
  const out = s.handle({ type: 'editCell', row: 0, col: 1, version: s.version, value: { t: 'text', v: 'x' } });
  assert.deepEqual(errors(out), ['Click "Enable editing" first.']);
  assert.equal(s.runSql('UPDATE products SET price = 9')[0].type, 'sqlError');
  assert.equal(s.pendingMessage().editing, false);
});

test('cell edits, insert, duplicate, delete and undo are staged; the grid shows them', () => {
  const s = open(makeDb('edit.db', SHOP));
  s.openTable('products');
  assert.deepEqual(types(s.enableEditing({})), ['pending', 'meta']);
  let out = s.editCell(0, 1, { t: 'auto', v: 'pencil' }, s.version);
  assert.deepEqual(types(out), ['objects', 'view', 'pending']);
  assert.equal(out.find(m => m.type === 'view').keepSel, true);
  assert.equal(s.getRows(1, 0, 1)[0].rows[0].cells[1], 'pencil');
  out = s.editCell(1, 2, { t: 'auto', v: '9.5' }, s.version);
  assert.equal(one(s, 'SELECT price FROM products WHERE id = 2'), 9.5);
  assert.equal(one(s, 'SELECT total FROM products WHERE id = 2'), 19, 'generated column follows');
  assert.deepEqual(errors(s.editCell(0, 4, { t: 'auto', v: '1' }, s.version)), ['total is a generated column. SQLite computes it.']);
  s.insertRow(s.version);
  assert.equal(s.viewCount, 4);
  assert.deepEqual(s.all('SELECT name, price FROM products WHERE id = 4').rows[0], ['', null]);
  assert.deepEqual(errors(s.duplicateRows(3, 3, s.version)), [], 'the new row has no sku, so a copy is fine');
  assert.equal(s.viewCount, 5);
  const before = s.pendingMessage().items.length;
  s.deleteRows(0, 1, s.version);
  assert.equal(s.pendingMessage().items.length, before + 1);
  assert.equal(one(s, 'SELECT COUNT(*) FROM products WHERE id IN (1, 2)'), 0);
  s.undo();
  assert.equal(one(s, 'SELECT COUNT(*) FROM products WHERE id IN (1, 2)'), 2, 'undo brings the rows back');
  const msg = s.pendingMessage();
  assert.ok(msg.items.every(i => /^(UPDATE|INSERT|DELETE)/.test(i.sql)));
  assert.match(msg.items[0].sql, /UPDATE "products" SET "name" = 'pencil' WHERE _rowid_ IN \(1\);/);
  s.discard();
  assert.equal(one(s, 'SELECT name FROM products WHERE id = 1'), 'pen');
  assert.equal(s.pendingMessage().items.length, 0);
});

test('constraint errors refuse the change and keep the pending list', () => {
  const s = open(makeDb('cons.db', SHOP));
  s.openTable('products');
  s.enableEditing({});
  s.editCell(0, 1, { t: 'text', v: 'ok' }, s.version);
  assert.match(errors(s.editCell(0, 2, { t: 'real', v: '-1' }, s.version))[0], /CHECK constraint refused the change \(price > 0\)/);
  assert.match(errors(s.editCell(0, 1, { t: 'null' }, s.version))[0], /products\.name cannot be NULL/);
  assert.match(errors(s.editCell(0, 3, { t: 'text', v: 'P2' }, s.version))[0], /UNIQUE/);
  assert.match(errors(s.duplicateRows(0, 0, s.version))[0], /UNIQUE.*different value/);
  assert.equal(s.pendingMessage().items.length, 1);
  assert.equal(one(s, 'SELECT name FROM products WHERE id = 1'), 'ok');
});

test('WITHOUT ROWID tables edit by primary key; views and query results are read-only', () => {
  const s = open(makeDb('kv.db', SHOP));
  s.enableEditing({});
  s.openTable('kv');
  s.editCell(1, 1, { t: 'auto', v: '20' }, s.version);
  assert.equal(one(s, "SELECT v FROM kv WHERE k = 'b'"), 20);
  assert.match(s.pendingMessage().items[0].sql, /WHERE "k" IN \('b'\)/);
  s.openTable('cheap');
  assert.equal(s.metaMessage().editable, 'Views are read-only.');
  s.runSql('SELECT * FROM products');
  assert.match(s.metaMessage().editable, /Query results are read-only/);
});

test('+ Row on a table with a NOT NULL foreign key uses an existing parent; deleting a referenced parent is refused', () => {
  const s = open(makeDb('fkrow.db', `PRAGMA foreign_keys = ON;
    CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO artist VALUES (7, 'A'), (9, 'B');
    CREATE TABLE album (id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artist(id));
    INSERT INTO album VALUES (1, 'x', 7);`));
  s.openTable('album');
  s.enableEditing({ foreignKeys: true });
  assert.deepEqual(errors(s.insertRow(s.version)), []);
  assert.deepEqual(s.all('SELECT title, artist_id FROM album WHERE id = 2').rows[0], ['', 7n]);
  s.openTable('artist');
  assert.match(errors(s.deleteRows(0, 0, s.version))[0], /foreign key refused the change/);
});

test('a stale view version is refused', () => {
  const s = open(makeDb('ver.db', SHOP));
  s.openTable('products');
  s.enableEditing({});
  assert.deepEqual(errors(s.editCell(0, 1, { t: 'text', v: 'x' }, s.version - 1)), ['The view changed. Try again.']);
});

test('SQL box: writes are staged, DDL updates the table list, blocked statements say why', () => {
  const s = open(makeDb('sql.db', SHOP));
  s.openTable('products');
  s.enableEditing({});
  let out = s.runSql('UPDATE products SET price = price * 2');
  const done = out.find(m => m.type === 'sqlDone');
  assert.equal(done.write, true);
  assert.equal(done.rows, 3);
  out = s.runSql('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  assert.ok(out.find(m => m.type === 'objects').tables.some(t => t.name === 'notes'));
  assert.match(s.runSql('VACUUM')[0].message, /do not run here/);
  assert.match(s.runSql('UPDATE products SET price = -1')[0].message, /CHECK.*Nothing was staged/);
  assert.equal(s.pendingMessage().items.length, 2);
  s.undo();
  assert.ok(!s.objectsMessage().tables.some(t => t.name === 'notes'));
});

test('save: backup, atomic replace, integrity ok in the sqlite3 tool, header and WAL mode kept', { skip: !hasSqlite3 && 'no sqlite3 tool' }, () => {
  const f = path.join(work, 'wal.db');
  cli(f, "PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b');");
  assert.ok(!fs.existsSync(f + '-wal') || W.walFrames(f) === 0, 'the CLI checkpointed on close');
  const fp = W.fingerprint(f);
  const before = fs.readFileSync(f);
  const s = open(f);
  s.openTable('t');
  s.enableEditing({});
  s.editCell(0, 1, { t: 'text', v: 'changed' }, s.version);
  s.insertRow(s.version);
  const img = s.buildImage([before[18], before[19]]);
  assert.equal(img.ok, true);
  const r = W.safeWrite(f, img.bytes, { baseline: fp, now: new Date(2026, 10, 9, 12, 0, 0) });
  assert.equal(path.basename(r.backup), 'wal.db.20261109-120000.bak');
  assert.deepEqual(fs.readFileSync(r.backup), before, 'the backup is the file as it was');
  assert.equal(cli(f, 'PRAGMA integrity_check'), 'ok');
  assert.equal(cli(f, 'PRAGMA journal_mode'), 'wal', 'still a WAL database');
  assert.equal(cli(f, 'SELECT group_concat(v) FROM t'), 'changed,b');
  assert.equal(fs.readdirSync(work).filter(n => n.includes('zovo-save')).length, 0, 'no temp file left');
  // Editing goes on after a save, and the next save makes another backup.
  s.markSaved(img.bytes.length);
  s.editCell(1, 1, { t: 'text', v: 'again' }, s.version);
  const img2 = s.buildImage([2, 2]);
  const r2 = W.safeWrite(f, img2.bytes, { baseline: W.fingerprint(f), now: new Date(2026, 10, 9, 12, 0, 0) });
  assert.equal(path.basename(r2.backup), 'wal.db.20261109-120000-2.bak');
  assert.equal(cli(f, "SELECT v FROM t WHERE id = 2"), 'again');
});

test('hostile: a file changed on disk after load is refused, and the pending list stays', { skip: !hasSqlite3 && 'no sqlite3 tool' }, () => {
  const f = makeDb('changed.db', SHOP);
  const fp = W.fingerprint(f);
  const s = open(f);
  s.openTable('products');
  s.enableEditing({});
  s.editCell(0, 1, { t: 'text', v: 'mine' }, s.version);
  cli(f, "UPDATE products SET name = 'theirs' WHERE id = 2");
  const check = W.checkWritable(f, fp);
  assert.equal(check.code, 'changed');
  assert.throws(() => W.safeWrite(f, new Uint8Array(10), { baseline: fp }), e => e.code === 'changed');
  assert.equal(cli(f, 'SELECT name FROM products WHERE id = 2'), 'theirs', 'their write is untouched');
  assert.equal(s.pendingMessage().items.length, 1);
  assert.deepEqual(fs.readdirSync(work).filter(n => n.startsWith('changed.db.')), [], 'no backup when nothing is written');
});

test('hostile: uncheckpointed -wal frames and a hot journal are refused', { skip: !hasSqlite3 && 'no sqlite3 tool' }, () => {
  const f = path.join(work, 'hotwal.db');
  // A Python writer leaves committed frames in the -wal (no checkpoint, connection still open when copied).
  execFileSync('python3', ['-I', '-c', `
import sqlite3, shutil, sys
p = sys.argv[1]
db = sqlite3.connect(p, isolation_level=None)
db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE t(a)'); db.execute('INSERT INTO t VALUES (1)')
shutil.copy(p, p + '.copy'); shutil.copy(p + '-wal', p + '.copy-wal')
`, f]);
  const copy = f + '.copy';
  assert.ok(W.walFrames(copy) > 0);
  const c = W.checkWritable(copy, W.fingerprint(copy));
  assert.equal(c.code, 'wal');
  assert.match(c.message, /Checkpoint and reload/);
  const j = makeDb('journal.db', 'CREATE TABLE t(a)');
  fs.writeFileSync(j + '-journal', Buffer.concat([W.JOURNAL_MAGIC, Buffer.alloc(504)]));
  assert.equal(W.checkWritable(j, W.fingerprint(j)).code, 'journal');
  fs.writeFileSync(j + '-journal', Buffer.alloc(512)); // a zeroed (finished) journal is fine
  assert.equal(W.checkWritable(j, W.fingerprint(j)).ok, true);
});

test('hostile: a read-only file (chmod 444) is refused before anything is written', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const f = makeDb('readonly.db', SHOP);
  fs.chmodSync(f, 0o444);
  try {
    const c = W.checkWritable(f, W.fingerprint(f));
    assert.equal(c.code, 'readonly');
    assert.throws(() => W.safeWrite(f, new Uint8Array(4096), { baseline: W.fingerprint(f) }), /read-only/);
    assert.deepEqual(fs.readdirSync(work).filter(n => n.startsWith('readonly.db.')), []);
  } finally { fs.chmodSync(f, 0o644); }
});

test('hostile: a deferred foreign key that breaks is refused at Save; pending list and file stay', () => {
  const f = makeDb('fk.db', SHOP);
  const before = fs.readFileSync(f);
  const s = open(f);
  s.openTable('child');
  s.enableEditing({ foreignKeys: true });
  const out = s.editCell(0, 1, { t: 'int', v: '999' }, s.version);
  assert.deepEqual(errors(out), [], 'a deferred key is checked at commit, not at the edit');
  const img = s.buildImage(null);
  assert.equal(img.ok, false);
  assert.match(img.message, /break a foreign key.*child row 1 points to a missing row in parent/);
  assert.equal(s.pendingMessage().items.length, 1);
  assert.equal(s.pendingMessage().canUndo, true);
  s.undo();
  assert.equal(one(s, 'SELECT parent_id FROM child'), 1);
  assert.deepEqual(fs.readFileSync(f), before);
});

test('large file: editing above the limit is refused with a clear message, viewing still works', () => {
  const f = makeDb('big.db', 'CREATE TABLE t(a)');
  const s = open(f, { fileSize: 300 * 1024 * 1024 });
  s.openTable('t');
  const out = s.enableEditing({ editLimitBytes: 256 * 1024 * 1024 });
  assert.equal(out[0].type, 'editRefused');
  assert.match(out[0].message, /up to 256 MB.*This file is 300 MB. It stays open read-only/);
  assert.equal(s.pendingMessage().editing, false);
});

test('Pro candidates: schema editing and find and replace are staged with Undo', () => {
  const s = open(makeDb('schema.db', SHOP));
  s.openTable('products');
  s.enableEditing({});
  s.schemaOp({ op: 'addColumn', table: 'products', column: 'stock', colType: 'INTEGER' });
  assert.ok(s.source.columns.some(c => c.name === 'stock'));
  s.schemaOp({ op: 'renameColumn', table: 'products', column: 'stock', newName: 'qty' });
  assert.ok(s.source.columns.some(c => c.name === 'qty'));
  s.schemaOp({ op: 'dropColumn', table: 'products', column: 'qty' });
  assert.ok(!s.source.columns.some(c => c.name === 'qty'));
  assert.match(errors(s.schemaOp({ op: 'dropColumn', table: 'products', column: 'sku' }))[0], /cannot drop UNIQUE column|UNIQUE/i);
  s.schemaOp({ op: 'renameTable', table: 'products', newName: 'items' });
  assert.equal(s.source.name, 'items');
  const out = s.findReplace({ table: 'items', column: 'name', find: 'P', replace: 'B', matchCase: false });
  assert.match(out.find(m => m.type === 'flash').message, /Replaced in 2 rows/);
  assert.deepEqual(s.all('SELECT name FROM items ORDER BY id').rows.map(r => r[0]), ['Ben', 'ink', 'Bad']);
  s.findReplace({ table: 'items', column: 'name', find: 'ink', replace: 'INK', whole: true, matchCase: true });
  assert.equal(one(s, 'SELECT name FROM items WHERE id = 2'), 'INK');
  s.undo(); s.undo(); s.undo();
  assert.ok(s.findObject('products'));
});

test('CSV import: preview guesses; Windows-1252 semicolons; TSV with quoted newlines; existing table mapping', async () => {
  const s = open(makeDb('imp.db', SHOP));
  s.openTable('products');
  s.enableEditing({});
  const semi = path.join(work, 'win1252.csv');
  fs.writeFileSync(semi, Buffer.concat([Buffer.from('Stadt;Preis;PLZ\r\n'), Buffer.from([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68]), Buffer.from(';1,5;08001\r\nK'), Buffer.from([0xf6]), Buffer.from('ln;2;50667\r\n')]));
  const p = I.previewCsv(semi);
  assert.equal(p.encoding, 'windows-1252');
  assert.equal(p.delimiter, ';');
  assert.equal(p.header, true);
  assert.deepEqual(p.names, ['Stadt', 'Preis', 'PLZ']);
  assert.deepEqual(p.types, ['TEXT', 'TEXT', 'TEXT']);
  assert.equal(p.rows[0][0], 'Zürich');
  let r = await I.runImport(s, { file: semi, encoding: p.encoding, delimiter: ';', header: true, mode: 'new', table: 'staedte', columns: p.names.map((n, i) => ({ src: i, name: n, type: p.types[i], transform: i === 1 ? 'number' : 'none' })) }, () => {}, () => false);
  assert.equal(r.rows, 2);
  assert.deepEqual(s.all('SELECT * FROM staedte').rows, [['Zürich', '15', '08001'], ['Köln', '2', '50667']]);

  const tsv = path.join(work, 'notes.tsv');
  fs.writeFileSync(tsv, 'sku\tname\tprice\nN1\t"two\nlines"\t3.5\nN2\tplain\t4\n');
  const pt = I.previewCsv(tsv);
  assert.equal(pt.delimiter, '\t');
  r = await I.runImport(s, { file: tsv, encoding: 'utf-8', delimiter: '\t', header: true, mode: 'existing', table: 'products', columns: [{ src: 0, name: 'sku' }, { src: 1, name: 'name' }, { src: 2, name: 'price' }] }, () => {}, () => false);
  assert.equal(r.rows, 2);
  assert.deepEqual(s.all("SELECT name, price, typeof(price) FROM products WHERE sku = 'N1'").rows[0], ['two\nlines', 3.5, 'real']);
  assert.match(s.pendingMessage().items.at(-1).label, /Import 2 rows from notes.tsv into products/);
  // A row that breaks a constraint stops the import at its line and adds nothing.
  const bad = path.join(work, 'bad.csv');
  fs.writeFileSync(bad, 'sku,name,price\nB1,ok,1\nB2,neg,-4\n');
  await assert.rejects(I.runImport(s, { file: bad, encoding: 'utf-8', delimiter: ',', header: true, mode: 'existing', table: 'products', columns: [{ src: 0, name: 'sku' }, { src: 1, name: 'name' }, { src: 2, name: 'price' }] }, () => {}, () => false), /line 3 of bad.csv: A CHECK constraint.*Nothing was added/);
  assert.equal(one(s, "SELECT COUNT(*) FROM products WHERE sku = 'B1'"), 0);
  await assert.rejects(I.runImport(s, { file: bad, encoding: 'utf-8', delimiter: ',', header: true, mode: 'new', table: 'PRODUCTS', columns: [{ src: 0, name: 'a' }] }, () => {}, () => false), /already exists/);
  assert.throws(() => I.previewCsv(path.join(work, 'imp.db')), /not a text file/);
});

test('1M-row CSV: streams with progress, Cancel rolls back, a full run finishes and saves', { timeout: 240000 }, async () => {
  const csv = path.join(work, 'million.csv');
  const fd = fs.openSync(csv, 'w');
  fs.writeSync(fd, 'id,name,amount,city\n');
  let chunk = [];
  for (let i = 1; i <= 1000000; i++) {
    chunk.push(`${i},"name ${i}",${(i % 1000) / 10},${i % 2 ? 'Paris' : '"New York, NY"'}`);
    if (chunk.length === 50000) { fs.writeSync(fd, chunk.join('\n') + '\n'); chunk = []; }
  }
  fs.closeSync(fd);
  const size = fs.statSync(csv).size;
  assert.ok(size > 30 * 1024 * 1024 && size < 50 * 1024 * 1024, `fixture is ${size} bytes`);
  const f = makeDb('million.db', 'CREATE TABLE seed(a)');
  const s = open(f);
  s.enableEditing({});
  const p = I.previewCsv(csv);
  assert.deepEqual(p.types, ['INTEGER', 'TEXT', 'REAL', 'TEXT']);
  assert.ok(p.estRows > 900000 && p.estRows < 1100000, String(p.estRows));
  const cols = p.names.map((n, i) => ({ src: i, name: n, type: p.types[i] }));
  // Cancel after the first progress tick.
  let ticks = 0;
  let cancel = false;
  await assert.rejects(I.runImport(s, { file: csv, encoding: 'utf-8', delimiter: ',', header: true, mode: 'new', table: 'big', columns: cols }, () => { ticks++; cancel = true; }, () => cancel), /cancelled/);
  assert.ok(ticks >= 1);
  assert.ok(!s.findObject('big') && s.all("SELECT 1 FROM sqlite_master WHERE name = 'big'").rows.length === 0, 'cancel removed the table');
  assert.equal(s.edit.busy, '');
  // Full run, with grid requests answered between chunks (the worker yields).
  const progress = [];
  let yields = 0;
  const run = I.runImport(s, { file: csv, encoding: 'utf-8', delimiter: ',', header: true, mode: 'new', table: 'big', columns: cols }, pr => progress.push(pr), () => false);
  const iv = setInterval(() => { yields++; }, 5);
  const r = await run;
  clearInterval(iv);
  assert.equal(r.rows, 1000000);
  assert.ok(progress.length >= 2, `progress ticks ${progress.length}`);
  assert.ok(yields > 10, `the event loop ran during the import (${yields})`);
  assert.equal(one(s, 'SELECT COUNT(*) FROM big'), 1000000);
  assert.equal(one(s, "SELECT city FROM big WHERE id = 2"), 'New York, NY');
  const img = s.buildImage(null);
  assert.equal(img.ok, true);
  W.safeWrite(f, img.bytes, { baseline: W.fingerprint(f) });
  if (hasSqlite3) {
    assert.equal(cli(f, 'SELECT COUNT(*) FROM big'), '1000000');
    assert.equal(cli(f, 'PRAGMA quick_check'), 'ok');
  }
});
