'use strict';
// Pure editing helpers: staged-statement rules, typed values, the streaming CSV parser, decoding and type guessing.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/core/edit');
const UI = require('../src/webview/editui');
const { validateWebviewMessage: v } = require('../src/core/protocol');

test('checkWrite: data and schema changes run, transaction control and ATTACH do not', () => {
  for (const s of ['INSERT INTO t VALUES (1)', 'update t set a = 1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'CREATE TABLE x (a)', 'ALTER TABLE t ADD COLUMN b', 'DROP TABLE t', 'WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c']) {
    assert.equal(E.checkWrite(s).ok, true, s);
  }
  assert.equal(E.checkWrite('CREATE INDEX i ON t(a)').ddl, true);
  assert.equal(E.checkWrite('UPDATE t SET a = 1').ddl, false);
  for (const s of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'RELEASE a', "ATTACH 'x.db' AS x", 'DETACH x', 'VACUUM', 'PRAGMA journal_mode = DELETE', 'INSERT INTO t VALUES (1); DELETE FROM t', 'END TRANSACTION']) {
    assert.equal(E.checkWrite(s).ok, false, s);
  }
  // Words inside strings do not count.
  assert.equal(E.checkWrite("INSERT INTO t VALUES ('begin; commit')").ok, true);
});

test('toValue: typed values, 64-bit integers, hex BLOBs and auto by affinity', () => {
  assert.deepEqual(E.toValue({ t: 'null' }), { ok: true, value: null });
  assert.deepEqual(E.toValue({ t: 'text', v: ' 01 ' }), { ok: true, value: ' 01 ' });
  assert.deepEqual(E.toValue({ t: 'int', v: '42' }), { ok: true, value: 42 });
  assert.equal(E.toValue({ t: 'int', v: '9223372036854775807' }).value, 9223372036854775807n);
  assert.equal(E.toValue({ t: 'int', v: '9223372036854775808' }).ok, false);
  assert.equal(E.toValue({ t: 'int', v: '4.5' }).ok, false);
  assert.equal(E.toValue({ t: 'real', v: '1e3' }).value, 1000);
  assert.equal(E.toValue({ t: 'real', v: 'abc' }).ok, false);
  assert.deepEqual([...E.toValue({ t: 'hex', v: "X'89504e47'" }).value], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual([...E.toValue({ t: 'hex', v: '0x00 ff' }).value], [0, 255]);
  assert.equal(E.toValue({ t: 'hex', v: 'abc' }).ok, false);
  assert.equal(E.toValue({ t: 'auto', v: '12' }, 'int').value, 12);
  assert.equal(E.toValue({ t: 'auto', v: '1.5' }, 'float').value, 1.5);
  assert.equal(E.toValue({ t: 'auto', v: '12' }, 'string').value, '12');
  assert.equal(E.toValue({ t: 'auto', v: '007' }, 'any').value, '007');
  assert.equal(E.toValue({ t: 'auto', v: '7' }, 'any').value, 7);
  assert.equal(E.toValue({ t: 'auto', v: 'x' }, 'int').value, 'x');
});

test('inlineParams writes values into the shown SQL, outside quoted names', () => {
  assert.equal(E.inlineParams('UPDATE "t?" SET "a" = ? WHERE _rowid_ IN (?)', ["it's", 5]), `UPDATE "t?" SET "a" = 'it''s' WHERE _rowid_ IN (5)`);
  assert.match(E.inlineParams('UPDATE t SET b = ?', [new Uint8Array(100)]), /X'0000.*100 bytes/);
});

test('CSV parser: quotes, doubled quotes, CRLF, quoted newlines, blank lines, BOM', () => {
  const rows = E.parseCsv('﻿a,b\r\n1,"x\r\ny"\r\n"q""z",3\n\n4,5', ',');
  assert.deepEqual(rows.map(r => [...r]), [['a', 'b'], ['1', 'x\r\ny'], ['q"z', '3'], ['4', '5']]);
  assert.deepEqual(E.parseCsv('a\tb\n"1\n2"\t3\n', '\t').map(r => [...r]), [['a', 'b'], ['1\n2', '3']]);
  assert.deepEqual(E.parseCsv('a,b\n1,', ',').map(r => [...r]), [['a', 'b'], ['1', '']]);
});

test('CSV parser gives the same rows whatever the chunk size', () => {
  const text = 'id;name;note\r\n1;"a;b";"say ""hi"""\r\n2;Zürich;"two\nlines"\r\n3;;\r\n';
  const whole = E.parseCsv(text, ';').map(r => [...r]);
  for (const size of [1, 2, 3, 5, 7, 64]) {
    const p = new E.CsvParser(';');
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
    out.push(...p.end());
    assert.deepEqual(out.map(r => [...r]), whole, `chunk ${size}`);
  }
  assert.deepEqual(whole[1], ['1', 'a;b', 'say "hi"']);
});

test('delimiter, encoding and types are guessed', () => {
  assert.equal(E.detectDelimiter('a;b;c\n1;2,5;3\n4;5;6'), ';');
  assert.equal(E.detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(E.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(E.detectDelimiter('a|b\n1|2'), '|');
  assert.equal(E.sniffEncoding(Buffer.from('Zürich', 'utf8')), 'utf-8');
  assert.equal(E.sniffEncoding(Buffer.from([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68])), 'windows-1252');
  assert.equal(E.sniffEncoding(Buffer.from([0xff, 0xfe, 0x41, 0])), 'utf-16le');
  // A sample cut inside a 2-byte character is still UTF-8.
  assert.equal(E.sniffEncoding(Buffer.from('aaü', 'utf8').subarray(0, 3)), 'utf-8');
  assert.equal(E.decode1252(Buffer.from([0x80, 0x93, 0x94, 0xe9])), '€“”é');
  assert.deepEqual(E.inferTypes([['1', '1.5', 'x', '007', ''], ['2', '2', 'y', '1', '']], 5), ['INTEGER', 'REAL', 'TEXT', 'TEXT', 'TEXT']);
  assert.deepEqual(E.headerNames(['id', 'ID', '', ' name '], 5), ['id', 'ID_2', 'column3', 'name', 'column5']);
  assert.equal(E.tableNameFromFile('/x/My Sales 2026.csv'), 'My_Sales_2026');
});

test('csvValue converts by target type; transforms', () => {
  assert.equal(E.csvValue('12', 'INTEGER'), 12);
  assert.equal(E.csvValue('', 'INTEGER'), null);
  assert.equal(E.csvValue('1.5', 'REAL'), 1.5);
  assert.equal(E.csvValue('abc', 'INTEGER'), 'abc');
  assert.equal(E.csvValue('', 'TEXT'), '');
  assert.equal(E.csvValue(undefined, 'TEXT'), null);
  assert.equal(E.csvValue(' A ', 'TEXT', 'trim'), 'A');
  assert.equal(E.csvValue('  ', 'TEXT', 'empty-null'), null);
  assert.equal(E.csvValue('1,234.5', 'REAL', 'number'), 1234.5);
  assert.equal(E.csvValue('Ab', 'TEXT', 'lower'), 'ab');
  assert.equal(E.csvValue('Ab', 'TEXT', 'upper'), 'AB');
});

test('newRowValues fills NOT NULL columns without a default', () => {
  const r = E.newRowValues([
    { name: 'id', type: 'INTEGER', notnull: true, dflt: null, rowidAlias: true },
    { name: 'n', type: 'TEXT', notnull: true, dflt: null },
    { name: 'q', type: 'INT', notnull: true, dflt: null },
    { name: 'd', type: 'TEXT', notnull: true, dflt: "'x'" },
    { name: 'g', type: 'TEXT', notnull: false, dflt: null },
  ]);
  assert.deepEqual(r, { cols: ['n', 'q'], vals: ['', 0] });
});

test('protocol: edit messages are checked', () => {
  assert.deepEqual(v({ type: 'editCell', row: 1, col: 2, version: 3, value: { t: 'text', v: 'x' } }), { type: 'editCell', row: 1, col: 2, version: 3, value: { t: 'text', v: 'x' } });
  assert.equal(v({ type: 'editCell', row: 1, col: 2, version: 3, value: { t: 'sql', v: 'x' } }), null);
  assert.equal(v({ type: 'editCell', row: -1, col: 2, version: 3, value: { t: 'text', v: 'x' } }), null);
  assert.equal(v({ type: 'deleteRows', r0: 5, r1: 2, version: 1 }), null);
  assert.deepEqual(v({ type: 'save', extra: 1 }), { type: 'save' });
  assert.deepEqual(v({ type: 'export', format: 'sql' }), { type: 'export', format: 'sql' });
  const run = { type: 'importRun', options: { encoding: 'utf-8', delimiter: ',', header: true, mode: 'new', table: 't', columns: [{ src: 0, name: 'a', type: 'TEXT' }], file: '/etc/passwd' } };
  const ok = v(run);
  assert.equal(ok.options.file, undefined, 'the webview never chooses the file path');
  assert.equal(v({ ...run, options: { ...run.options, delimiter: 'x' } }), null);
  assert.equal(v({ ...run, options: { ...run.options, columns: [{ src: 0, name: 'a', transform: 'eval' }] } }), null);
  assert.equal(v({ type: 'schemaAction', action: 'dropTable' }), null);
  assert.deepEqual(v({ type: 'schemaAction', action: 'dropColumn', col: 2 }), { type: 'schemaAction', action: 'dropColumn', col: 2 });
});

test('editui: inline editing, change detection and import options', () => {
  assert.equal(UI.inlineKind('abc'), 'inline');
  assert.equal(UI.inlineKind('a\nb'), 'panel');
  assert.equal(UI.inlineKind({ b: 10, k: 'png' }), 'panel');
  assert.equal(UI.inlineKind({ t: 'x', n: 5000 }), 'panel');
  assert.equal(UI.inlineKind({ i: '9223372036854775807' }), 'inline');
  assert.equal(UI.inlineKind(null), 'inline');
  assert.equal(UI.changed(null, ''), false);
  assert.equal(UI.changed(null, 'x'), true);
  assert.equal(UI.changed(5, '5'), false);
  assert.equal(UI.changed('a', 'b'), true);
  const p = { names: ['id', 'Name', 'x'], types: ['INTEGER', 'TEXT', 'TEXT'], table: 'sales', encoding: 'utf-8', delimiter: ',', header: true };
  const f = UI.importForm(p, null);
  f.columns[2].include = false;
  assert.deepEqual(UI.importOptions(p, f).options.columns, [{ src: 0, name: 'id', type: 'INTEGER', transform: 'none' }, { src: 1, name: 'Name', type: 'TEXT', transform: 'none' }]);
  f.mode = 'existing';
  f.targetColumns = ['ID', 'name', 'other'];
  UI.autoMap(p, f);
  assert.deepEqual(f.columns.map(c => c.target), ['ID', 'name', 'other']);
  f.columns[1].target = 'ID';
  assert.equal(UI.importOptions(p, f).ok, false);
  assert.equal(UI.progressText({ rows: 1000, bytes: 50, size: 100 }), '1,000 rows · 50 B of 100 B (50%)');
});
