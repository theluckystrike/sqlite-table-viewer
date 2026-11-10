'use strict';
// Zovo Pro switch (0.4.0): Pro is on for the three new tools only. The 0.3.0 table tools stay free. 3 free tries per
// tool, a try is used only after the files were written, Escape in the dialog costs nothing, showProFeatures hides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createPro, PRO_ENABLED, FEATURES, TOOLS, TRIES_KEY } = require('../src/pro');
const pkg = require('../package.json');

function fakeVscode({ show = true } = {}) {
  const ctx = [];
  const status = [];
  const cfgListeners = [];
  const settings = { showProFeatures: show };
  return {
    ctx, status, settings,
    fire: () => cfgListeners.forEach(fn => fn({ affectsConfiguration: k => k === 'sqliteTableViewer.showProFeatures' })),
    commands: { executeCommand: async (...a) => { ctx.push(a); } },
    window: { setStatusBarMessage: m => { status.push(m); return { dispose() {} }; } },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      onDidChangeConfiguration: fn => { cfgListeners.push(fn); return { dispose() {} }; },
    },
  };
}
function fakeContext() {
  const store = new Map();
  return { subscriptions: [], globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } }, store };
}
function fakeLicense(pro = false) {
  const asked = [];
  let answer = false;
  return {
    asked, ready: Promise.resolve(), pro,
    setAnswer(v) { answer = v; },
    isPro() { return this.pro; },
    requirePro: async (name, detail) => { asked.push([name, detail]); return answer; },
    onDidChange() { return { dispose() {} }; },
    handleUri: async () => false,
  };
}
const lastCtx = (v, key) => [...v.ctx].reverse().find(a => a[1] === key)[2];

test('Pro is on in 0.4.0, but the 0.3.0 table tools stay free (require always says yes)', async () => {
  assert.equal(PRO_ENABLED, true);
  const v = fakeVscode();
  const pro = createPro({ vscode: v, context: fakeContext(), license: fakeLicense(false) });
  for (const k of Object.keys(FEATURES)) assert.equal(await pro.require(k), true, k);
  assert.equal(pro.isPro(), true, 'the old isPro() check used by editHost stays true');
  assert.deepEqual(Object.keys(TOOLS).sort(), ['compare', 'erd', 'exportAll']);
});

test('3 free tries per tool; a try is used by spend() only, after the files were written', async () => {
  const v = fakeVscode();
  const lic = fakeLicense(false);
  const ctx = fakeContext();
  const pro = createPro({ vscode: v, context: ctx, license: lic });
  // allow() alone (the user pressed Escape later, or the job failed) uses nothing
  for (let i = 0; i < 5; i++) assert.equal(await pro.allow('compare'), true);
  assert.equal(pro.triesLeft('compare'), 3);
  for (let i = 1; i <= 3; i++) {
    assert.equal(await pro.allow('compare'), true);
    assert.equal(await pro.spend('compare'), 3 - i);
  }
  assert.equal(pro.triesLeft('compare'), 0);
  assert.equal(lic.asked.length, 0, 'no dialog during the free tries');
  assert.match(v.status[0], /Free try 1 of 3 used \(2 left\)/);
  assert.match(v.status[2], /Free try 3 of 3 used, that was the last one/);
  // tries are per tool
  assert.equal(pro.triesLeft('erd'), 3);
  assert.equal(await pro.allow('erd'), true);
  assert.deepEqual(ctx.store.get(TRIES_KEY), { compare: 3 });
});

test('4th use: one dialog that names USD 19; Escape (false) costs nothing and runs nothing', async () => {
  const v = fakeVscode();
  const lic = fakeLicense(false);
  const ctx = fakeContext();
  const pro = createPro({ vscode: v, context: ctx, license: lic });
  for (let i = 0; i < 3; i++) await pro.spend('erd');
  assert.equal(await pro.allow('erd'), false);
  assert.equal(lic.asked.length, 1);
  assert.equal(lic.asked[0][0], 'ER diagram and schema document');
  // EXEC14: structured panel text; the shared module writes "You used the 3 free tries" and the USD 19 paragraph.
  assert.equal(lic.asked[0][1].triesUsed, 3);
  assert.match(lic.asked[0][1].detail, /^Writes an ER diagram/);
  const { createLicense } = require('../src/license');
  const real = createLicense({ vscode: { window: {}, commands: { registerCommand: () => ({ dispose() {} }) } }, context: { subscriptions: [], secrets: { get: async () => undefined, onDidChange: () => ({ dispose() {} }) }, globalState: { get: () => undefined, update: async () => {} } }, sku: 'sqlite-pro', name: 'Zovo', product: 'SQLite Editor', proTools: ['Compare databases', 'ER diagram and schema document', 'Export all tables'] });
  const text = real.panelDetail('ER diagram and schema document', lic.asked[0][1]);
  assert.match(text, /^You used the 3 free tries on this computer\./);
  assert.match(text, /USD 19 once, for life\. It turns on Compare databases and Export all tables here/);
  assert.deepEqual(ctx.store.get(TRIES_KEY), { erd: 3 }, 'Escape did not change the count');
  lic.setAnswer(true); // unlocked in the dialog
  lic.pro = true;
  assert.equal(await pro.allow('erd'), true);
});

test('licensed: no tries counted, no status message, badge state licensed', async () => {
  const v = fakeVscode();
  const lic = fakeLicense(true);
  lic.setAnswer(true);
  const ctx = fakeContext();
  const pro = createPro({ vscode: v, context: ctx, license: lic });
  assert.equal(await pro.allow('exportAll'), true);
  assert.equal(await pro.spend('exportAll'), Infinity);
  assert.equal(ctx.store.get(TRIES_KEY), undefined);
  assert.equal(v.status.length, 0);
  assert.deepEqual(pro.state(), { enabled: true, licensed: true, visible: true });
});

test('showProFeatures=false hides the Pro UI unless licensed; the change applies at once', async () => {
  const v = fakeVscode({ show: false });
  const pro = createPro({ vscode: v, context: fakeContext(), license: fakeLicense(false) });
  assert.equal(lastCtx(v, 'sqliteTableViewer.proVisible'), false);
  const seen = [];
  pro.onDidChange(s => seen.push(s.visible));
  v.settings.showProFeatures = true;
  v.fire();
  assert.equal(lastCtx(v, 'sqliteTableViewer.proVisible'), true);
  assert.deepEqual(seen, [true]);
  const v2 = fakeVscode({ show: false });
  createPro({ vscode: v2, context: fakeContext(), license: fakeLicense(true) });
  assert.equal(lastCtx(v2, 'sqliteTableViewer.proVisible'), true, 'a license keeps its commands visible');
});

test('package.json: Pro commands and license commands follow proVisible; settings; name, id and engine kept', () => {
  assert.equal(pkg.version, '0.4.1');
  assert.equal(pkg.name, 'sqlite-table-viewer');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.displayName, 'SQLite Editor & Viewer, SQLite3 Database Browser (Edit Cells, CSV Import)');
  assert.equal(pkg.engines.vscode, '^1.90.0');
  const cmds = pkg.contributes.commands.map(c => c.command);
  const pal = pkg.contributes.menus.commandPalette;
  for (const id of ['proTools', 'compareDatabases', 'erDiagram', 'exportAllTables'].map(x => `sqliteTableViewer.${x}`)) {
    assert.ok(cmds.includes(id), id);
    assert.ok(pal.some(m => m.command === id && m.when === 'sqliteTableViewer.proVisible'), id);
  }
  for (const id of ['enterLicenseKey', 'getPro', 'unlockWithSponsors', 'payWithPayPal', 'removeLicense'].map(x => `sqliteTableViewer.${x}`)) {
    assert.ok(cmds.includes(id), id);
    assert.ok(pal.some(m => m.command === id && m.when === 'sqliteTableViewer.proEnabled && sqliteTableViewer.proVisible'), id);
  }
  const ex = pkg.contributes.menus['explorer/context'].find(m => m.command === 'sqliteTableViewer.proTools');
  assert.match(ex.when, /sqliteTableViewer\.proVisible/);
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['sqliteTableViewer.showProFeatures'].default, true);
  assert.equal(props['sqliteTableViewer.compareMaxStatements'].default, 1000000);
  assert.ok(!pkg.activationEvents.some(e => /\*/.test(e)), 'no * activation');
});

test('the free part is complete: editHost gates nothing (old keys answer yes), and nothing Pro runs on open', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/editHost.js'), 'utf8');
  const gated = [...src.matchAll(/pro\.require\('(\w+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(gated, ['replace', 'schema', 'transforms']);
  const ext = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  assert.ok(!/allow\(/.test(ext), 'extension.js never asks for Pro by itself');
  assert.ok(/proEnabled: false/.test(ext), 'the webview keeps the 0.3.0 table tools without a Pro label');
  const host = fs.readFileSync(path.join(__dirname, '../src/proHost.js'), 'utf8');
  // each tool: allow() before the work, spend() only after a successful job
  for (const t of ['compare', 'erd', 'exportAll']) {
    const a = host.indexOf(`pro.allow('${t}')`);
    const s = host.indexOf(`pro.spend('${t}')`);
    assert.ok(a > 0 && s > a, t);
    assert.ok(/if \(!r\.ok\) \{ failed\(/.test(host.slice(a, s)), `${t}: an error returns before spend`);
  }
});

test('license module files are byte-identical to the factory copy', { skip: !fs.existsSync(path.join(process.env.HOME || '', 'plugin-market-intel-work/factory/sprint/license/index.js')) && 'no factory checkout' }, () => {
  const fac = path.join(process.env.HOME, 'plugin-market-intel-work/factory/sprint/license');
  for (const f of ['index.js', 'license.js', 'sponsors.js']) {
    assert.ok(fs.readFileSync(path.join(__dirname, '../src/license', f)).equals(fs.readFileSync(path.join(fac, f))), f);
  }
});

test('price text: USD 19 in README, CHANGELOG and the dialog text; never USD 15', () => {
  const root = path.join(__dirname, '..');
  const files = ['README.md', 'CHANGELOG.md', 'package.json', 'src/pro.js', 'src/proHost.js', 'src/license/index.js', 'src/license/license.js', 'src/license/sponsors.js'];
  for (const f of files) assert.ok(!/USD\s*15\b/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const first = readme.split('\n').find(l => l.startsWith('Free, no paywall'));
  assert.match(first, /Zovo Pro \(USD 19 once, all Zovo extensions\)/);
  assert.match(first, /Everything that is free today stays free/);
  assert.match(readme, /## Free and Zovo Pro/);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## 0\.4\.0[\s\S]*USD 19 once/);
});
