'use strict';
// Support links: the sponsor field in package.json, the two commands, and the setting that hides the footer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const P = 'sqliteTableViewer';

test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const support = require('../src/support');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes(P + '.supportDeveloper') && ids.includes(P + '.moreViewers'));
  const cfg = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const props = Object.assign({}, ...cfg.map(c => c.properties));
  assert.strictEqual(props[P + '.showSupportLinks'].default, true);
  assert.ok(support.otherProducts('zovo.sqlite-table-viewer').every(p => p.id !== 'zovo.sqlite-table-viewer'));
});

test('support: the footer shows by default and sqliteTableViewer.showSupportLinks=false hides it', async () => {
  const dist = path.join(root, 'dist', 'extension.js');
  if (!fs.existsSync(dist)) require('child_process').execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js'), '--production']);
  for (const [settings, shown] of [[{}, true], [{ showSupportLinks: false }, false]]) {
    let provider;
    const commands = new Map();
    const vscode = {
      Uri: { joinPath: (u, ...p) => ({ path: path.posix.join(u.path, ...p), fsPath: path.join(u.fsPath, ...p) }) },
      window: { registerCustomEditorProvider: (id, p) => { provider = p; return { dispose() {} }; }, showInformationMessage: async () => {}, tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => {} },
      // a file over the size limit: the host stops before it starts the reader
      workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), fs: { stat: async () => ({ size: 1e15 }) } },
      env: { clipboard: { writeText: async () => {} } },
    };
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
    let dispose = () => {};
    try {
      delete require.cache[dist];
      require(dist).activate({ subscriptions: [], extensionUri: { path: '/ext', fsPath: '/ext' }, extensionPath: '/ext', globalState: { get: (k, d) => d, update: async () => {} } });
      assert.ok(commands.has(P + '.supportDeveloper') && commands.has(P + '.moreViewers'));
      const webview = { cspSource: 'vscode-webview://t', options: null, html: '', asWebviewUri: u => ({ toString: () => 'vscode-webview://t' + u.path }), postMessage: () => Promise.resolve(true), onDidReceiveMessage: () => ({ dispose() {} }) };
      const panel = { webview, visible: true, onDidDispose: fn => { dispose = fn; return { dispose() {} }; }, onDidChangeViewState: () => ({ dispose() {} }) };
      await provider.resolveCustomEditor({ uri: { scheme: 'file', path: '/x/big.db', fsPath: '/x/big.db' } }, panel);
      assert.strictEqual(/id="zovo-support"/.test(webview.html), shown, JSON.stringify(settings));
      assert.strictEqual(webview.html.includes('command:sqliteTableViewer.moreViewers'), shown);
      assert.deepStrictEqual(webview.options.enableCommandUris, [P + '.supportDeveloper', P + '.moreViewers', 'sqliteTableViewer.getPro', 'sqliteTableViewer.payWithPayPal', 'workbench.action.openSettings']);
    } finally { try { dispose(); } catch { /* not opened */ } Module._load = orig; }
  }
});
