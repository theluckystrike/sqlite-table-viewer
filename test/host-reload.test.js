'use strict';
// Drives the real extension host code with a stub of the vscode API and a real worker thread:
// a write to the -wal file reloads the view by itself; with autoReload off a notice is sent instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-host-'));
const settings = {};
const uri = (p) => ({ scheme: 'file', path: p, fsPath: p, toString: () => 'file://' + p, with: (o) => uri(o.path || p) });
const vscodeStub = {
  Uri: { joinPath: (u, ...p) => uri(path.posix.join(u.path, ...p)) },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async (k, v) => { settings[k] = v; } }),
    fs: { stat: async (u) => ({ size: fs.statSync(u.fsPath).size }), readFile: async (u) => fs.readFileSync(u.fsPath) },
    createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: { registerCustomEditorProvider: () => ({ dispose() {} }), showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } },
  env: { clipboard: { writeText: async () => {} } },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  TabInputText: class {},
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension');

// A writer that keeps the database open in WAL mode and adds 5 rows each time it reads a line on stdin.
const WRITER = String.raw`
import sqlite3, sys, os
p = sys.argv[1]
db = sqlite3.connect(p, isolation_level=None)
db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
db.executemany('INSERT INTO t(v) VALUES (?)', [('a',)] * 10)
print('ready', flush=True)
for line in sys.stdin:
    db.executemany('INSERT INTO t(v) VALUES (?)', [('b',)] * 5)
    print('wrote', flush=True)
`;

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

const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };

test('a write to the -wal reloads the view; with autoReload off a notice is sent', { timeout: 30000 }, async () => {
  const db = path.join(dir, 'live.db');
  const { spawn } = require('child_process');
  const w = spawn('python3', ['-I', '-c', WRITER, db], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  w.stdout.on('data', (b) => lines.push(...String(b).trim().split('\n')));
  try {
    assert.ok(await until(() => lines.includes('ready')), 'writer ready');
    const p = openPanel(db);
    await p.post({ type: 'ready' });
    assert.ok(await until(() => p.sent.find((m) => m.type === 'objects')), 'objects');
    await p.post({ type: 'openTable', name: 't' });
    assert.ok(await until(() => p.sent.find((m) => m.type === 'meta' && m.viewCount === 10)), 'meta 10');
    w.stdin.write('go\n');
    const re = await until(() => p.sent.find((m) => m.type === 'meta' && m.keep && m.viewCount === 15));
    assert.ok(re, 'reloaded meta with 15 rows: ' + JSON.stringify(p.sent.map((m) => m.type)));
    assert.ok(p.sent.find((m) => m.type === 'reloaded'));
    settings.autoReload = false;
    w.stdin.write('go\n');
    assert.ok(await until(() => p.sent.find((m) => m.type === 'fileChanged')), 'fileChanged notice');
    await p.post({ type: 'reload' });
    assert.ok(await until(() => p.sent.find((m) => m.type === 'meta' && m.keep && m.viewCount === 20)), 'manual reload 20 rows');
    p.dispose();
  } finally {
    w.kill();
    delete settings.autoReload;
    Module._load = origLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
