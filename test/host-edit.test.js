'use strict';
// Drives the real extension host and worker thread with a stub of the vscode API: Enable editing, a cell edit,
// Save (backup + atomic replace, no self-reload), a CSV import, and the refusals for a changed file and a read-only file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-edit-'));
const hasSqlite3 = (() => { try { execFileSync('sqlite3', ['-version']); return true; } catch { return false; } })();
const cli = (file, sql) => execFileSync('sqlite3', [file, sql]).toString().trim();
const settings = {};
const shown = [];
let openDialog = null;
const uri = (p) => ({ scheme: 'file', path: p, fsPath: p, toString: () => 'file://' + p, with: (o) => uri(o.path || p) });
const vscodeStub = {
  Uri: { joinPath: (u, ...p) => uri(path.posix.join(u.path, ...p)), file: (p) => uri(p) },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async (k, v) => { settings[k] = v; } }),
    fs: { stat: async (u) => ({ size: fs.statSync(u.fsPath).size }), readFile: async (u) => fs.readFileSync(u.fsPath), writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b) },
    createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose() {} }),
    showInformationMessage: async (m) => { shown.push(['info', m]); return undefined; },
    showWarningMessage: async (m) => { shown.push(['warn', m]); return undefined; },
    showErrorMessage: async (m) => { shown.push(['error', m]); return undefined; },
    showOpenDialog: async () => openDialog,
    showSaveDialog: async () => undefined,
    tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) },
  },
  env: { clipboard: { writeText: async () => {} } },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  TabInputText: class {},
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension');

function openPanel(file) {
  const sent = [];
  let onMsg = null;
  let onDispose = null;
  const panel = {
    visible: true,
    webview: {
      options: null, html: '', cspSource: 'vscode-webview://test',
      asWebviewUri: (u) => ({ toString: () => 'vscode-webview://test' + u.path }),
      postMessage: async (m) => { sent.push(m); return true; },
      onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: (fn) => { onDispose = fn; return { dispose() {} }; },
  };
  const ctx = { subscriptions: [], extensionUri: uri(root), extensionPath: root, globalState: { get: (k, d) => d, update: async () => {} } };
  const provider = new ext.DatabaseEditorProvider(ctx);
  provider.resolveCustomEditor({ uri: uri(file) }, panel);
  return { sent, post: (m) => onMsg(m), dispose: () => onDispose && onDispose() };
}
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastPending = (p) => [...p.sent].reverse().find((m) => m.type === 'pending');
const ver = (p) => [...p.sent].reverse().find((m) => m.type === 'meta' || m.type === 'view').version;

test.after(() => { Module._load = origLoad; fs.rmSync(dir, { recursive: true, force: true }); });

test('real host: read-only open, Enable editing, edit, Save with backup, no self-reload, then refusal of a changed file', { skip: !hasSqlite3 && 'no sqlite3 tool', timeout: 40000 }, async () => {
  const db = path.join(dir, 'shop.db');
  cli(db, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL CHECK (price > 0)); INSERT INTO items (name, price) VALUES ('pen', 1.5), ('ink', 4);");
  const before = fs.readFileSync(db);
  const p = openPanel(db);
  await p.post({ type: 'ready' });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'init' && m.canEdit === true && m.proEnabled === false)), 'init says editing is possible, Pro is off');
  assert.ok(await until(() => p.sent.find((m) => m.type === 'objects')), 'objects');
  await p.post({ type: 'openTable', name: 'items' });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'meta' && m.source.name === 'items')), 'table opens');
  // Read-only until enabled.
  await p.post({ type: 'editCell', row: 0, col: 1, version: 1, value: { t: 'text', v: 'x' } });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'editError' && /Enable editing/.test(m.message))));
  await p.post({ type: 'enableEditing' });
  assert.ok(await until(() => lastPending(p) && lastPending(p).editing), 'editing on');
  const meta = [...p.sent].reverse().find((m) => m.type === 'meta');
  await p.post({ type: 'editCell', row: 0, col: 1, version: meta.version, value: { t: 'auto', v: 'pencil' } });
  assert.ok(await until(() => lastPending(p).items.length === 1));
  await p.post({ type: 'editCell', row: 1, col: 2, version: ver(p), value: { t: 'auto', v: '-3' } });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'editError' && /CHECK/.test(m.message))), 'CHECK refused');
  assert.deepEqual(fs.readFileSync(db), before, 'nothing written before Save');
  // Ctrl+S
  await p.post({ type: 'save' });
  const saved = await until(() => p.sent.find((m) => m.type === 'saved'));
  assert.ok(saved, 'saved: ' + JSON.stringify(p.sent.filter((m) => /save/i.test(m.type))));
  assert.ok(fs.existsSync(saved.backup));
  assert.deepEqual(fs.readFileSync(saved.backup), before);
  assert.equal(cli(db, 'PRAGMA integrity_check'), 'ok');
  assert.equal(cli(db, 'SELECT name FROM items WHERE id = 1'), 'pencil');
  assert.equal(lastPending(p).items.length, 0);
  assert.ok(shown.some(([k, m]) => k === 'info' && /Saved 1 change to shop.db/.test(m)));
  await sleep(2500);
  assert.ok(!p.sent.some((m) => m.type === 'reloaded' || (m.type === 'fileChanged')), 'our own save does not reload the view');
  // Another program writes; the next Save is refused and keeps the change.
  await p.post({ type: 'editCell', row: 1, col: 1, version: ver(p), value: { t: 'text', v: 'mine' } });
  assert.ok(await until(() => lastPending(p).items.length === 1));
  cli(db, "UPDATE items SET price = 9 WHERE id = 2");
  assert.ok(await until(() => p.sent.find((m) => m.type === 'fileChanged' && m.editing)), 'change on disk noticed, no reload');
  await p.post({ type: 'save' });
  const failed = await until(() => p.sent.find((m) => m.type === 'saveFailed'));
  assert.equal(failed.code, 'changed');
  assert.equal(lastPending(p).items.length, 1, 'pending change kept');
  assert.equal(cli(db, 'SELECT name || price FROM items WHERE id = 2'), 'ink9.0', 'their write is kept');
  // Discard, stop editing, reload: the view shows their write.
  await p.post({ type: 'discard' });
  await p.post({ type: 'disableEditing' });
  assert.ok(await until(() => lastPending(p) && !lastPending(p).editing));
  await p.post({ type: 'reload' });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'reloaded')));
  p.dispose();
});

test('real host: CSV import into a new table, staged then saved', { skip: !hasSqlite3 && 'no sqlite3 tool', timeout: 40000 }, async () => {
  const db = path.join(dir, 'imp.db');
  cli(db, 'CREATE TABLE seed (a)');
  const csv = path.join(dir, 'people.csv');
  fs.writeFileSync(csv, 'id,name,city\n1,Ann,"Paris, FR"\n2,Bo,Oslo\n');
  openDialog = [uri(csv)];
  const p = openPanel(db);
  await p.post({ type: 'ready' });
  await until(() => p.sent.find((m) => m.type === 'objects'));
  await p.post({ type: 'importCsv' });
  const pv = await until(() => p.sent.find((m) => m.type === 'importPreview'));
  assert.ok(pv, 'preview');
  assert.deepEqual(pv.names, ['id', 'name', 'city']);
  await p.post({ type: 'importRun', options: { encoding: pv.encoding, delimiter: pv.delimiter, header: true, mode: 'new', table: 'people', columns: pv.names.map((n, i) => ({ src: i, name: n, type: pv.types[i] })) } });
  const done = await until(() => p.sent.find((m) => m.type === 'importDone'));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.ok(await until(() => p.sent.find((m) => m.type === 'meta' && m.source.name === 'people' && m.viewCount === 2)), 'grid shows the new table');
  await p.post({ type: 'save' });
  assert.ok(await until(() => p.sent.find((m) => m.type === 'saved')));
  assert.equal(cli(db, "SELECT city FROM people WHERE id = 1"), 'Paris, FR');
  openDialog = null;
  p.dispose();
});

test('real host: a read-only file cannot enter editing mode', { skip: process.platform === 'win32' && 'chmod', timeout: 20000 }, async () => {
  const db = path.join(dir, 'locked.db');
  fs.copyFileSync(path.join(dir, 'shop.db'), db);
  fs.chmodSync(db, 0o444);
  try {
    const p = openPanel(db);
    await p.post({ type: 'ready' });
    await until(() => p.sent.find((m) => m.type === 'objects'));
    await p.post({ type: 'enableEditing' });
    const r = await until(() => p.sent.find((m) => m.type === 'editRefused'));
    assert.equal(r.code, 'readonly');
    p.dispose();
  } finally { fs.chmodSync(db, 0o644); }
});
