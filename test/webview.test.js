'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/webview/cells');
const M = require('../src/webview/math');
const { buildHtml } = require('../src/html');

test('grid cell display', () => {
  assert.deepStrictEqual(C.display(null), { text: '', cls: 'null' });
  assert.deepStrictEqual(C.display(3.5), { text: '3.5', cls: 'num' });
  assert.deepStrictEqual(C.display({ i: '9007199254740993' }), { text: '9007199254740993', cls: 'num' });
  assert.strictEqual(C.display({ b: 2048, k: 'png' }).text, 'BLOB 2.0 KB · PNG');
  assert.strictEqual(C.display('a\nb').text, 'a ⏎ b');
  assert.ok(C.display({ t: 'abc', n: 5000 }).text.endsWith('…'));
  assert.strictEqual(C.display('<b>x</b>').text, '<b>x</b>');
  assert.strictEqual(C.shortCount(25000), '25k');
  assert.strictEqual(C.shortCount(1250000), '1.3M');
  assert.strictEqual(C.num(0.000012345), '1.2345e-5');
  assert.strictEqual(C.prettyJson('{"a":1}'), '{\n  "a": 1\n}');
});

test('grid math from Table Viewer still holds', () => {
  assert.deepStrictEqual(M.pagesFor(190, 410, 200), [0, 1, 2]);
  assert.deepStrictEqual(M.nextSort({ col: 2, dir: 'asc' }, 2), { col: 2, dir: 'desc' });
  const r = M.scrollToRow(M.MAX_BODY_PX, 1000000, 24, 600);
  assert.strictEqual(r.first, 1000000 - 25);
});

test('webview HTML has a strict CSP with a nonce and no remote or eval sources', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'a.js', styleUri: 'b.css', title: '<x>"' });
  const csp = html.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]{32}'/);
  assert.ok(!/unsafe-eval|wasm|https?:/.test(csp));
  assert.ok(html.includes('&lt;x&gt;&quot;'));
});

test('the webview writes file content with textContent only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/webview/main.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
});

test('hex dump re-flows to 8 bytes per row for a narrow cell panel', () => {
  const { hexDump } = require('../src/core/sqlutil');
  const bytes = Uint8Array.from({ length: 37 }, (_, i) => (i === 3 ? 0x41 : i));
  const wide = hexDump(bytes);
  assert.strictEqual(C.hexRows(wide, 16), wide);
  const rows = C.hexRows(wide, 8).split('\n');
  assert.strictEqual(rows.length, 5); // 37 bytes: 8 + 8 + 8 + 8 + 5
  assert.strictEqual(rows[0], '00000000  00 01 02 41 04 05 06 07  ...A....');
  assert.strictEqual(rows[1], '00000008  08 09 0a 0b 0c 0d 0e 0f  ........');
  assert.strictEqual(rows[4], '00000020  ' + '20 21 22 23 24'.padEnd(23) + '  ' + ' !"#$', 'short last row keeps the ASCII column aligned');
  assert.ok(rows.every((r) => r.length <= 43), 'each row fits 43 columns');
  const all = (s, end) => s.split('\n').map((r) => r.slice(10, end).trim()).join(' ').split(/\s+/).filter(Boolean);
  assert.deepStrictEqual(all(C.hexRows(wide, 8), 33), all(wide, 58), 'same bytes in the same order');
  const big = hexDump(Uint8Array.from({ length: 4096 }, (_, i) => i & 255));
  assert.strictEqual(C.hexRows(big, 8).split('\n').length, 512);
});
