'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateWebviewMessage: v } = require('../src/core/protocol');

test('accepts well-formed messages', () => {
  assert.deepStrictEqual(v({ type: 'ready', extra: 1 }), { type: 'ready' });
  assert.deepStrictEqual(v({ type: 'openTable', name: 'orders' }), { type: 'openTable', name: 'orders' });
  assert.deepStrictEqual(v({ type: 'getRows', reqId: 3, start: 200, count: 200 }), { type: 'getRows', reqId: 3, start: 200, count: 200 });
  assert.deepStrictEqual(v({ type: 'sort', col: null }), { type: 'sort', col: null, dir: null });
  assert.deepStrictEqual(v({ type: 'filter', global: 'x', columns: { 2: '=a' } }), { type: 'filter', global: 'x', columns: { 2: '=a' } });
  assert.strictEqual(v({ type: 'copy', format: 'insert', sel: { r0: 0, r1: 2, c0: 0, c1: 1 } }).sel.header, true);
  assert.deepStrictEqual(v({ type: 'export' }), { type: 'export', format: undefined });
  assert.strictEqual(v({ type: 'runSql', sql: 'select 1' }).sql, 'select 1');
});

test('drops anything unexpected', () => {
  for (const m of [null, 'ready', {}, { type: 'nope' }, { type: 'openTable', name: '' }, { type: 'openTable', name: 5 },
    { type: 'getRows', reqId: 1, start: -1, count: 10 }, { type: 'getRows', reqId: 1, start: 0, count: 5000 },
    { type: 'sort', col: 1, dir: 'sideways' }, { type: 'sort', col: '1; drop', dir: 'asc' },
    { type: 'filter', columns: { 'a': 'x' } }, { type: 'filter', columns: [] }, { type: 'filter', global: 'x'.repeat(5000) },
    { type: 'copy', format: 'xml', sel: { r0: 0, r1: 0, c0: 0, c1: 0 } }, { type: 'copy', format: 'csv', sel: { r0: 2, r1: 1, c0: 0, c1: 0 } },
    { type: 'export', format: 'xlsx' }, { type: 'runSql', sql: '   ' }, { type: 'cell', row: 1.5, col: 0 }]) {
    assert.strictEqual(v(m), null, JSON.stringify(m));
  }
});
