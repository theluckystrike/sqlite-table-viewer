'use strict';
// Zovo Pro tools (0.4.0): compare + sync script round trip, ER diagram and schema document, export of every table,
// and the VS Code flow (dialogs, worker, files on disk, tries) through a stub of the vscode API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const P = require('../src/core/protools');
const U = require('../src/core/sqlutil');
const { zipFiles, crc32 } = require('../src/core/zip');
const { createPro } = require('../src/pro');
const { createProTools } = require('../src/proHost');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-pro6-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let SQL;
test.before(async () => { SQL = await initSqlJs(); });

const SCHEMA_A = `
CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, note TEXT);
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, total REAL, placed TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "order items"(order_id INTEGER REFERENCES orders(id), line INTEGER, sku TEXT, qty INTEGER, PRIMARY KEY(order_id, line)) WITHOUT ROWID;
CREATE TABLE log(msg TEXT);
CREATE TABLE onlya(x INTEGER PRIMARY KEY, y BLOB);
CREATE TABLE nokey(a, b) ;
CREATE INDEX ix_orders_c ON orders(customer_id);
CREATE VIEW big AS SELECT * FROM orders WHERE total > 100;
CREATE TRIGGER tr_audit AFTER INSERT ON orders BEGIN INSERT INTO log(msg) VALUES('order ' || new.id); END;
INSERT INTO customers VALUES (1, 'Ann', 'ann@example.com', 'a|b'), (2, 'Bob', NULL, NULL), (3, 'Cé ''quoted''', NULL, 'line1
line2');
INSERT INTO orders(id, customer_id, total, placed) VALUES (1, 1, 10.5, '2026-01-01'), (2, 1, 200, '2026-01-02'), (3, 2, 0.1, '2026-01-03');
INSERT INTO "order items" VALUES (1, 1, 'A-1', 2), (1, 2, 'B-2', 1), (2, 1, 'C-3', 5);
INSERT INTO onlya VALUES (1, x'00ff10');
INSERT INTO nokey VALUES (1, 2);
`;
const CHANGE_B = `
DROP TRIGGER tr_audit;
UPDATE customers SET name = 'Robert', note = 'n' WHERE id = 2; DELETE FROM customers WHERE id = 3; INSERT INTO customers VALUES (9, 'Zed', 'z@example.com', NULL);
DROP TABLE onlya; CREATE TABLE onlyb(q); INSERT INTO onlyb VALUES (1);
DELETE FROM orders WHERE id = 3; UPDATE orders SET total = NULL WHERE id = 1;
ALTER TABLE log ADD COLUMN extra INT; INSERT INTO log(msg) VALUES ('b only');
DELETE FROM "order items" WHERE line = 2; INSERT INTO "order items" VALUES (2, 9, 'Z', 1);
DROP INDEX ix_orders_c; CREATE INDEX ix_orders_c ON orders(customer_id, total);
DROP VIEW big; CREATE VIEW big AS SELECT * FROM orders WHERE total > 50;
`;
function makeDb(sql) { const db = new SQL.Database(); db.exec(sql); return db; }
const copy = db => new SQL.Database(db.export());
function runCompare(a, b, opts = {}) {
  let script = '';
  const r = P.compareDatabases(a, b, { write: s => { script += s; } }, { labelA: 'a.db', labelB: 'b.db', scriptName: 'sync.sql', now: 'T', ...opts });
  return { ...r, script };
}

test('compare: counts schema and row differences and writes a report', () => {
  const a = makeDb(SCHEMA_A);
  const b = copy(a);
  b.exec(CHANGE_B);
  const r = runCompare(a, b);
  assert.equal(r.same, false);
  assert.deepEqual(r.summary, { tablesOnlyA: 1, tablesOnlyB: 1, tablesChanged: 1, rowsOnlyA: 3, rowsOnlyB: 3, rowsChanged: 2, noKey: 0 });
  assert.match(r.report, /^# Database compare: a\.db and b\.db/);
  assert.match(r.report, /\| customers \| id \| 3 \| 3 \| 1 \| 1 \| 1 \|/);
  assert.match(r.report, /\| 2 \| differs \| name \| Bob \| Robert \|/);
  assert.match(r.report, /\| order items \| order_id, line \| 3 \| 3 \| 1 \| 1 \| 0 \|/);
  assert.match(r.report, /\| 1 \| differs \| total \| 10\.5 \| NULL \|/);
  assert.match(r.report, /### log: structure differs[\s\S]*column only in B \| extra/);
  assert.match(r.report, /Views only in A: none; only in B: none; different: `big`/);
  assert.match(r.script, /^-- Sync script/);
  assert.match(r.script, /PRAGMA foreign_keys = OFF;\nBEGIN;/);
  assert.match(r.script, /COMMIT;\nPRAGMA foreign_keys = ON;/);
  assert.ok(!/ROLLBACK/.test(r.script));
});

test('compare: running the sync script on a copy of B makes it equal to A (rows, schema, triggers)', () => {
  const a = makeDb(SCHEMA_A);
  const b = copy(a);
  b.exec(CHANGE_B);
  const r = runCompare(a, b);
  const b2 = copy(b);
  b2.exec(r.script);
  const again = runCompare(a, b2);
  assert.equal(again.same, true, again.report);
  assert.deepEqual(b2.exec('SELECT name FROM customers ORDER BY id')[0].values, [['Ann'], ['Bob'], ["Cé 'quoted'"]]);
  assert.deepEqual(b2.exec('SELECT hex(y) FROM onlya')[0].values, [['00FF10']]);
  assert.equal(b2.exec("SELECT count(*) FROM sqlite_master WHERE name = 'onlyb'")[0].values[0][0], 0);
  assert.equal(b2.exec('PRAGMA integrity_check')[0].values[0][0], 'ok');
  // the trigger of A came back, and it did not fire while rows were copied (log equals A's log)
  assert.deepEqual(b2.exec('SELECT msg FROM log ORDER BY rowid'), a.exec('SELECT msg FROM log ORDER BY rowid'));
  assert.equal(b2.exec("SELECT count(*) FROM sqlite_master WHERE type = 'trigger'")[0].values[0][0], 1);
});

test('compare: equal databases need no change; the files are only read', () => {
  const a = makeDb(SCHEMA_A);
  const before = Buffer.from(a.export());
  const r = runCompare(a, copy(a));
  assert.equal(r.same, true);
  assert.deepEqual(r.summary, { tablesOnlyA: 0, tablesOnlyB: 0, tablesChanged: 0, rowsOnlyA: 0, rowsOnlyB: 0, rowsChanged: 0, noKey: 0 });
  assert.ok(Buffer.from(a.export()).equals(before));
  assert.equal(a.exec('PRAGMA database_list')[0].values.length, 1, 'B is detached again');
});

test('compare: a script over the statement limit ends with ROLLBACK and changes nothing', () => {
  const a = makeDb('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);');
  const ins = a.prepare('INSERT INTO t VALUES (?, ?)');
  for (let i = 1; i <= 5000; i++) ins.run([i, 'v' + i]);
  ins.free();
  const b = makeDb('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);');
  const r = runCompare(a, b, { maxStatements: 1000 });
  assert.equal(r.capped, true);
  assert.equal(r.summary.rowsOnlyA, 5000, 'the report still counts every row');
  assert.match(r.script, /STOPPED after 1,000 statements[\s\S]*ROLLBACK;\n$/);
  b.exec(r.script);
  assert.equal(b.exec('SELECT count(*) FROM t')[0].values[0][0], 0);
  assert.match(r.report, /ends with ROLLBACK/);
});

test('ER: Mermaid has every table, keys and one line per foreign key; odd names get an alias', () => {
  const m = P.schemaModel(makeDb(SCHEMA_A));
  const mm = P.erMermaid(m);
  assert.match(mm, /^erDiagram\n/);
  assert.match(mm, /  customers \{\n    INTEGER id PK\n    TEXT name\n    TEXT email UK\n/);
  assert.match(mm, /INTEGER customer_id FK/);
  assert.match(mm, /order_items\["order items"\] \{/);
  assert.match(mm, /customers \|\|--o\{ orders : "customer_id"/);
  assert.match(mm, /orders \|\|--o\{ order_items : "order_id"/);
  assert.equal((mm.match(/--o\{/g) || []).length, 2);
});

test('ER: the SVG has a box per table, a path per foreign key, and escapes names', () => {
  const db = makeDb(SCHEMA_A + 'CREATE TABLE "<b>&x"(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES "<b>&x"(id));');
  const svg = P.erSvg(P.schemaModel(db), { title: 'shop.db' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.equal((svg.match(/<g><rect/g) || []).length, 7);
  assert.equal((svg.match(/marker-start="url\(#many\)"/g) || []).length, 3);
  assert.ok(svg.includes('&lt;b&gt;&amp;x'));
  assert.ok(!svg.includes('<b>&x'));
  // tables that others point to are left of them
  const x = name => Number(new RegExp(`<g><rect x="(\\d+(?:\\.\\d+)?)"[^>]*/>\\n<path[^\\n]*\\n<text[^>]*>${name}<`).exec(svg)[1]);
  assert.ok(x('customers') < x('orders'));
  assert.ok(x('orders') < x('order items'));
});

test('ER: the Markdown document lists every table, column, foreign key, index, view and trigger', () => {
  const doc = P.schemaMarkdown(P.schemaModel(makeDb(SCHEMA_A)), { title: 'shop.db', svgName: 'shop-er.svg', mmdName: 'shop-er.mmd', now: 'T' });
  assert.match(doc, /^# shop\.db: database schema/);
  assert.match(doc, /6 tables, 1 views, 1 indexes, 1 triggers, 2 foreign keys\./);
  assert.match(doc, /\[shop-er\.svg\]\(shop-er\.svg\)/);
  assert.match(doc, /```mermaid\nerDiagram/);
  assert.match(doc, /\| customer_id \| INTEGER \| FK \| yes \|  \| customers\(id\) on delete cascade \|/);
  assert.match(doc, /- `ix_orders_c` \(customer_id\)/);
  assert.match(doc, /## Views\n\n### big/);
  assert.match(doc, /### tr_audit \(on orders\)/);
  assert.match(doc, /Referenced by \[orders\]\(#orders\)/);
});

/** Reads a zip made by zipFiles: { name: Buffer }. Checks the CRC of every entry. */
function unzip(buf) {
  const out = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(crc32(out[name]), crc, name);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test('export all: an .xlsx workbook with one sheet per table, numbers as numbers, text escaped', () => {
  const db = makeDb(SCHEMA_A + 'CREATE TABLE "a/b:c*d?[e]"(v); INSERT INTO "a/b:c*d?[e]" VALUES (\'<&>\');');
  const w = P.workbookParts(db);
  assert.deepEqual(w.sheets.map(s => [s.table, s.sheet, s.rows]), [
    ['a/b:c*d?[e]', 'a_b_c_d__e_', 1], ['customers', 'customers', 3], ['log', 'log', 3], ['nokey', 'nokey', 1],
    ['onlya', 'onlya', 1], ['order items', 'order items', 3], ['orders', 'orders', 3]]);
  const files = unzip(zipFiles(w.files));
  assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml'] && files['xl/styles.xml']);
  const wb = files['xl/workbook.xml'].toString();
  assert.equal((wb.match(/<sheet name=/g) || []).length, 7);
  const cust = files['xl/worksheets/sheet2.xml'].toString();
  assert.match(cust, /<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">id<\/t>/);
  assert.match(cust, /<c r="A2"><v>1<\/v><\/c><c r="B2" t="inlineStr"><is><t xml:space="preserve">Ann<\/t>/);
  assert.match(files['xl/worksheets/sheet1.xml'].toString(), /&lt;&amp;&gt;/);
  assert.match(files['xl/worksheets/sheet5.xml'].toString(), /\(BLOB 3 bytes\)/);
  assert.match(cust, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
});

test('export all: the row limit is kept per table and reported', () => {
  const db = makeDb(SCHEMA_A);
  const w = P.workbookParts(db, { maxRows: 2 });
  assert.deepEqual(w.sheets.filter(s => s.truncated).map(s => s.table), ['customers', 'log', 'order items', 'orders']);
  const files = [];
  const res = P.csvTables(db, (f, t) => files.push([f, t]), { maxRows: 2 });
  assert.equal(res.find(r => r.table === 'customers').rows, 2);
  assert.ok(res.find(r => r.table === 'customers').truncated);
});

test('export all: one CSV file per table with safe, unique names', () => {
  const db = makeDb(SCHEMA_A + 'CREATE TABLE "../x"(v); CREATE TABLE "..-x"(v);');
  const parts = {};
  const res = P.csvTables(db, (f, t) => { parts[f] = (parts[f] || '') + t; });
  assert.deepEqual(res.map(r => r.file), ['_-x.csv', '__x.csv', 'customers.csv', 'log.csv', 'nokey.csv', 'onlya.csv', 'order_items.csv', 'orders.csv']);
  for (const f of Object.keys(parts)) assert.ok(!f.includes('/') && !f.startsWith('.'), f);
  assert.equal(new Set(Object.keys(parts).map(f => f.toLowerCase())).size, Object.keys(parts).length);
  assert.equal(parts['customers.csv'], 'id,name,email,note\r\n1,Ann,ann@example.com,a|b\r\n2,Bob,,\r\n3,Cé \'quoted\',,"line1\nline2"\r\n');
});

// ---------- the VS Code flow ----------

const hasWorker = fs.existsSync(path.join(root, 'dist', 'proworker.js'));
function harness() {
  const calls = { open: [], save: [], pick: [], info: [], error: [], warn: [], opened: [], status: [], modal: [] };
  const queue = { open: [], save: [], pick: [] };
  const uri = p => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p });
  class TabInputCustom {}
  const store = new Map();
  const vscode = {
    Uri: { file: uri },
    TabInputCustom,
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2 },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      openTextDocument: async u => ({ uri: u }),
    },
    window: {
      tabGroups: { activeTabGroup: { activeTab: null } },
      showOpenDialog: async o => { calls.open.push(o); return queue.open.shift(); },
      showSaveDialog: async o => { calls.save.push(o); return queue.save.shift(); },
      showQuickPick: async (items, o) => { calls.pick.push([items, o]); const id = queue.pick.shift(); return id && items.find(i => i.id === id); },
      showInformationMessage: async (m, ...rest) => { calls.info.push(m); if (rest[0] && rest[0].modal) calls.modal.push(m); return undefined; },
      showErrorMessage: async m => { calls.error.push(m); },
      showWarningMessage: async m => { calls.warn.push(m); },
      showTextDocument: async d => { calls.opened.push(d.uri.fsPath); },
      setStatusBarMessage: m => { calls.status.push(m); return { dispose() {} }; },
      withProgress: (o, fn) => fn({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    },
    commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose() {} }) },
  };
  const context = { subscriptions: [], globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } } };
  const lic = { ready: Promise.resolve(), isPro: () => false, requirePro: async (n, d) => { calls.modal.push(n + ': ' + d); return false; }, onDidChange: () => ({ dispose() {} }) };
  const pro = createPro({ vscode, context, license: lic });
  const tools = createProTools({ vscode, pro, extensionPath: root });
  return { vscode, calls, queue, uri, pro, tools, store };
}
function writeDb(file, sql) {
  const db = makeDb(sql);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

test('VS Code flow: ER diagram writes 3 files and uses one try; Escape at the save dialog uses none', { skip: !hasWorker && 'run npm run build first' }, async () => {
  const h = harness();
  const db = path.join(dir, 'shop.db');
  writeDb(db, SCHEMA_A);
  const bytes = fs.readFileSync(db);
  h.queue.save.push(undefined); // Escape
  assert.equal(await h.tools.erd(h.uri(db)), false);
  assert.equal(h.pro.triesLeft('erd'), 3);
  h.queue.save.push(h.uri(path.join(dir, 'shop-schema.md')));
  assert.equal(await h.tools.erd(h.uri(db)), true, h.calls.error.join('\n'));
  for (const f of ['shop-schema.md', 'shop-er.svg', 'shop-er.mmd']) assert.ok(fs.statSync(path.join(dir, f)).size > 100, f);
  assert.match(fs.readFileSync(path.join(dir, 'shop-er.mmd'), 'utf8'), /customers \|\|--o\{ orders/);
  assert.equal(h.pro.triesLeft('erd'), 2);
  assert.deepEqual(h.calls.opened, [path.join(dir, 'shop-schema.md')]);
  assert.match(h.calls.status[0], /Free try 1 of 3/);
  assert.ok(fs.readFileSync(db).equals(bytes), 'the database file was not changed');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.part')), []);
});

test('VS Code flow: compare writes the report and the sync script and opens both; a bad B costs nothing', { skip: !hasWorker && 'run npm run build first' }, async () => {
  const h = harness();
  const a = path.join(dir, 'a.db');
  const b = path.join(dir, 'b.db');
  writeDb(a, SCHEMA_A);
  writeDb(b, SCHEMA_A + CHANGE_B);
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'not a database at all, just some text for the header check');
  // B is not SQLite: error, nothing written, no try used
  h.queue.open.push([h.uri(junk)]);
  h.queue.save.push(h.uri(path.join(dir, 'x-compare.md')));
  assert.equal(await h.tools.compare(h.uri(a)), false);
  assert.match(h.calls.error[0], /junk\.db is not a SQLite database/);
  assert.equal(h.pro.triesLeft('compare'), 3);
  assert.ok(!fs.existsSync(path.join(dir, 'x-compare.md')) && !fs.existsSync(path.join(dir, 'x-sync.sql')));
  // Escape in the B dialog
  h.queue.open.push(undefined);
  assert.equal(await h.tools.compare(h.uri(a)), false);
  // the real run
  h.queue.open.push([h.uri(b)]);
  h.queue.save.push(h.uri(path.join(dir, 'a-vs-b-compare.md')));
  assert.equal(await h.tools.compare(h.uri(a)), true, h.calls.error.join('\n'));
  const report = fs.readFileSync(path.join(dir, 'a-vs-b-compare.md'), 'utf8');
  const script = fs.readFileSync(path.join(dir, 'a-vs-b-sync.sql'), 'utf8');
  assert.match(report, /Rows only in A \| 3 \|/);
  assert.match(script, /UPDATE "customers" SET "name" = 'Bob', "note" = NULL WHERE "id" = 2;/);
  assert.deepEqual(h.calls.opened, [path.join(dir, 'a-vs-b-compare.md'), path.join(dir, 'a-vs-b-sync.sql')]);
  assert.match(h.calls.info.at(-1), /The sync script was not run\./);
  assert.equal(h.pro.triesLeft('compare'), 2);
  // B on disk is unchanged until someone runs the script
  const bdb = new SQL.Database(fs.readFileSync(b));
  assert.equal(bdb.exec('SELECT name FROM customers WHERE id = 2')[0].values[0][0], 'Robert');
  bdb.exec(script);
  const adb = new SQL.Database(fs.readFileSync(a));
  assert.equal(runCompare(adb, bdb).same, true);
});

test('VS Code flow: export all to xlsx and CSV; after 3 tries the 4th start shows the dialog and runs nothing', { skip: !hasWorker && 'run npm run build first' }, async () => {
  const h = harness();
  const db = path.join(dir, 'exp.db');
  writeDb(db, SCHEMA_A);
  for (let i = 1; i <= 3; i++) {
    const out = path.join(dir, `exp-${i}.xlsx`);
    h.queue.pick.push(i === 2 ? 'csv' : 'xlsx');
    if (i === 2) h.queue.open.push([h.uri(path.join(dir))]); else h.queue.save.push(h.uri(out));
    assert.equal(await h.tools.exportAll(h.uri(db)), true, h.calls.error.join('\n'));
  }
  const files = unzip(fs.readFileSync(path.join(dir, 'exp-1.xlsx')));
  assert.equal((files['xl/workbook.xml'].toString().match(/<sheet name=/g) || []).length, 6);
  assert.equal(fs.readFileSync(path.join(dir, 'exp-csv', 'orders.csv'), 'utf8').split('\r\n')[0], 'id,customer_id,total,placed');
  assert.equal(h.pro.triesLeft('exportAll'), 0);
  const before = h.calls.pick.length;
  assert.equal(await h.tools.exportAll(h.uri(db)), false);
  assert.equal(h.calls.modal.length, 1);
  assert.match(h.calls.modal[0], /^Export all tables: .*You used the 3 free tries.*USD 19 once/);
  assert.equal(h.calls.pick.length, before, 'no format list after Escape in the dialog');
});
