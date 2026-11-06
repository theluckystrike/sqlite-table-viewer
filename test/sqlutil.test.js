'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/core/sqlutil');

const enc = s => new Uint8Array(Buffer.from(s, 'latin1'));

test('sniff finds the SQLite header', () => {
  assert.strictEqual(U.sniff(enc('SQLite format 3\u0000rest')), 'sqlite');
  assert.strictEqual(U.sniff(new Uint8Array(0)), 'empty');
  assert.strictEqual(U.sniff(enc('SQLite format 2\u0000')), 'other');
  assert.strictEqual(U.sniff(enc('short')), 'other');
});

test('not-SQLite messages tell text from probably-encrypted files', () => {
  assert.match(U.notSqliteMessage(enc('hello world\n'), 12), /plain text/);
  const rnd = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
  assert.match(U.notSqliteMessage(rnd, 4096), /encrypted/);
  assert.match(U.notSqliteMessage(rnd.subarray(0, 300), 300), /not a SQLite database/);
});

test('friendly errors for corrupt and encrypted files', () => {
  assert.match(U.friendlyOpenError(new Error('database disk image is malformed')), /damaged/);
  assert.match(U.friendlyOpenError(new Error('file is not a database')), /encrypted or damaged/);
});

test('prepareBytes switches a WAL header to rollback in a copy only', () => {
  const b = new Uint8Array(100); b[18] = 2; b[19] = 2;
  const c = U.prepareBytes(b);
  assert.deepStrictEqual([c[18], c[19]], [1, 1]);
  assert.deepStrictEqual([b[18], b[19]], [2, 2]);
});

test('read-only check allows reads and refuses writes', () => {
  for (const ok of ['SELECT 1', 'select * from t;', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES (1),(2)', 'PRAGMA table_info(t)', 'PRAGMA user_version', 'EXPLAIN QUERY PLAN SELECT 1',
    "SELECT 'delete from t' AS s", 'SELECT "update" FROM t -- drop table t', 'SELECT 1 /* ; insert */']) {
    assert.strictEqual(U.checkReadOnly(ok).ok, true, ok);
  }
  for (const bad of ['DELETE FROM t', 'insert into t values (1)', 'UPDATE t SET a = 1', 'DROP TABLE t', 'ATTACH \'x.db\' AS x', 'PRAGMA query_only = 0', 'PRAGMA query_only(0)',
    'PRAGMA writable_schema', 'SELECT 1; DELETE FROM t', 'WITH x AS (SELECT 1) DELETE FROM t', 'VACUUM', 'VACUUM INTO \'/tmp/x\'', 'create table x(a)', '', '  ;  ', 'EXPLAIN DELETE FROM t']) {
    assert.strictEqual(U.checkReadOnly(bad).ok, false, bad);
  }
  assert.strictEqual(U.checkReadOnly('SELECT 1').mode, 'select');
  assert.strictEqual(U.checkReadOnly('PRAGMA table_list').mode, 'list');
});

test('filters bind every value as a parameter', () => {
  const col = U.quoteIdent('na"me');
  assert.strictEqual(col, '"na""me"');
  const inj = U.filterClause(col, "x' OR 1=1 --");
  assert.ok(!inj.sql.includes('OR 1=1'));
  assert.deepStrictEqual(inj.params, ["%x' OR 1=1 --%"]);
  assert.deepStrictEqual(U.filterClause('"a"', '>10'), { sql: '"a" > ?', params: [10] });
  assert.deepStrictEqual(U.filterClause('"a"', '=paid'), { sql: '"a" = ?', params: ['paid'] });
  assert.deepStrictEqual(U.filterClause('"a"', '5..9').params, [5, 9]);
  assert.match(U.filterClause('"a"', '!x').sql, /NOT LIKE/);
  assert.deepStrictEqual(U.filterClause('"a"', '50%_off').params, ['%50\\%\\_off%']);
  assert.strictEqual(U.filterClause('"a"', 'empty').params.length, 0);
  assert.strictEqual(U.filterClause('"a"', '   '), null);
  const w = U.buildWhere(['a', 'b'], { global: 'q', columns: { 0: '>1', 7: 'ignored' } });
  assert.strictEqual(w.params.length, 3);
  assert.match(w.sql, /^ WHERE "a" > \? AND \(/);
});

test('affinity follows SQLite rules', () => {
  assert.strictEqual(U.affinity('INTEGER'), 'int');
  assert.strictEqual(U.affinity('VARCHAR(20)'), 'string');
  assert.strictEqual(U.affinity('DOUBLE PRECISION'), 'float');
  assert.strictEqual(U.affinity('BLOB'), 'blob');
  assert.strictEqual(U.affinity(''), 'any');
  assert.strictEqual(U.affinity('NUMERIC'), 'decimal');
});

test('cells: blobs, big integers, long text, images and vectors', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  assert.deepStrictEqual(U.encodeCell(png), { b: 10, k: 'png' });
  assert.deepStrictEqual(U.encodeCell(9007199254740993n), { i: '9007199254740993' });
  assert.strictEqual(U.encodeCell(42n), 42);
  assert.strictEqual(U.encodeCell('x'.repeat(2000)).n, 2000);
  const d = U.describeCell(png);
  assert.ok(d.image.startsWith('data:image/png;base64,'));
  assert.match(d.hex, /^00000000 {2}89 50 4e 47/);
  const f = new Float32Array([0.6, 0.8, 0, 0]);
  const v = U.describeCell(new Uint8Array(f.buffer));
  assert.strictEqual(v.vectors[0].dim, 4);
  assert.ok(Math.abs(v.vectors[0].norm - 1) < 1e-6);
  assert.strictEqual(U.vectorStats(new Uint8Array(16), 4), null);
  assert.strictEqual(U.describeCell('{"a":[1,2]}').json, true);
  assert.strictEqual(U.describeCell('{not json}').json, undefined);
  assert.strictEqual(U.blobKind(new Uint8Array([0xff, 0xd8, 0xff, 0])), 'jpeg');
});

test('export formats: CSV quoting, JSON values and INSERT statements', () => {
  const rows = [[1, 'a,b', null, new Uint8Array([0, 255])], [2n ** 60n, 'say "hi"', 1.5, null]];
  const csv = U.formatRows(['id', 'txt', 'r', 'b'], rows, 'csv');
  assert.strictEqual(csv.split('\r\n')[1], '1,"a,b",,0x00ff');
  assert.ok(csv.includes('1152921504606846976,"say ""hi""",1.5,'));
  const json = JSON.parse(U.formatRows(['id', 'txt', 'r', 'b'], rows, 'json'));
  assert.strictEqual(json[1].id, '1152921504606846976');
  assert.strictEqual(json[0].b, '0x00ff');
  const ins = U.formatRows(['id', 'txt'], [[1, "it's"]], 'insert', { table: 'my"t' });
  assert.strictEqual(ins, 'INSERT INTO "my""t" ("id", "txt") VALUES (1, \'it\'\'s\');');
  assert.strictEqual(U.formatRows(['a'], [[1]], 'tsv', { header: false }), '1');
});
