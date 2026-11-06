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
