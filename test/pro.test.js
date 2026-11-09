'use strict';
// The Pro switch: off at ship (every feature free, no license command shows); on, the license module decides.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPro, PRO_ENABLED, FEATURES } = require('../src/pro');
const pkg = require('../package.json');

const fakeVscode = (ctx) => ({ commands: { executeCommand: async (...a) => { ctx.push(a); } } });

test('ships with PRO_ENABLED = false: every feature runs, nothing is asked', async () => {
  assert.equal(PRO_ENABLED, false);
  const calls = [];
  const pro = createPro({ vscode: fakeVscode(calls), context: {} });
  assert.equal(pro.enabled, false);
  assert.equal(pro.isPro(), true);
  for (const k of Object.keys(FEATURES)) assert.equal(await pro.require(k), true);
  assert.deepEqual(calls, [['setContext', 'sqliteTableViewer.proEnabled', false]]);
});

test('switched on: the license decides, one requirePro per user action', async () => {
  const asked = [];
  const license = { isPro: () => false, requirePro: async (name, detail) => { asked.push([name, detail]); return false; } };
  const pro = createPro({ vscode: fakeVscode([]), context: {}, enabled: true, license });
  assert.equal(pro.isPro(), false);
  assert.equal(await pro.require('schema'), false);
  assert.equal(asked[0][0], 'Schema editing');
  const ok = createPro({ vscode: fakeVscode([]), context: {}, enabled: true, license: { isPro: () => true, requirePro: async () => true } });
  assert.equal(await ok.require('replace'), true);
});

test('license commands are listed but hidden from the palette unless Pro is on', () => {
  const ids = ['enterLicenseKey', 'getPro', 'unlockWithSponsors', 'removeLicense'].map((x) => `sqliteTableViewer.${x}`);
  const cmds = pkg.contributes.commands.map((c) => c.command);
  for (const id of ids) {
    assert.ok(cmds.includes(id), id);
    assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === id && m.when === 'sqliteTableViewer.proEnabled'), id);
  }
});

test('the free part is complete: opening, viewing, editing, Save, SQL and plain CSV import are never gated', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/editHost.js'), 'utf8');
  const gated = [...src.matchAll(/pro\.require\('(\w+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(gated, ['replace', 'schema', 'transforms']);
});
