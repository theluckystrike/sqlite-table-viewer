'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const { sniff } = require('./core/sqlutil');

const VIEW_TYPE = 'sqliteTableViewer.database';
const KNOWN_EXT = /\.(db|sqlite|sqlite3|db3|s3db|sl3|vscdb|gpkg)$/i;
const STATE_MESSAGES = new Set(['meta', 'view', 'rows', 'objects']);
const HISTORY_KEY = 'sqliteTableViewer.history';
const HISTORY_MAX = 20;

function settings() {
  const c = vscode.workspace.getConfiguration('sqliteTableViewer');
  return {
    maxFileSizeMB: c.get('maxFileSizeMB', 512),
    copyMaxRows: c.get('copyMaxRows', 100000),
    exportMaxRows: c.get('exportMaxRows', 1000000),
  };
}

const EXPORT_CHOICES = [
  { id: 'csv', label: 'CSV', description: 'comma-separated, with a header row' },
  { id: 'json', label: 'JSON', description: 'one array of objects' },
];

/** First 16 bytes of a file, or null when it cannot be read. */
async function readHead(uri) {
  try {
    if (uri.scheme === 'file') {
      const fd = await fs.promises.open(uri.fsPath, 'r');
      try { const b = Buffer.alloc(16); const { bytesRead } = await fd.read(b, 0, 16, 0); return b.subarray(0, bytesRead); } finally { await fd.close(); }
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > 64 * 1024 * 1024) return null;
    return (await vscode.workspace.fs.readFile(uri)).subarray(0, 16);
  } catch { return null; }
}

class DatabaseEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    const uri = document.uri;
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
    });

    const opts = settings();
    let worker = null;
    let disposed = false;
    let webviewReady = false;
    let fatal = null;
    let exportTarget = null;
    const warnings = [];
    const queue = [];
    const toWebview = msg => {
      if (disposed) return;
      if (webviewReady) { panel.webview.postMessage(msg); return; }
      if (!STATE_MESSAGES.has(msg.type) && !(msg.type === 'error' && !msg.transient)) queue.push(msg);
    };
    const failHost = message => { fatal = { type: 'error', message }; toWebview(fatal); };
    const history = () => ctx.globalState.get(HISTORY_KEY, []);

    const startWorker = async () => {
      const limit = opts.maxFileSizeMB * 1024 * 1024;
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > limit) {
        throw new Error(`This database is ${(stat.size / 1048576).toFixed(0)} MB. SQLite Table Viewer loads the whole file into memory, and the limit is ${opts.maxFileSizeMB} MB (setting sqliteTableViewer.maxFileSizeMB). Open a smaller copy, or raise the limit if this machine has the memory.`);
      }
      let source;
      if (uri.scheme === 'file') {
        source = { path: uri.fsPath };
        try {
          const wal = fs.statSync(uri.fsPath + '-wal');
          if (wal.size > 0) warnings.push(`A ${name}-wal file sits next to this database: uncommitted WAL changes are not shown. Rows written since the last checkpoint are missing until the app that owns the database checkpoints or closes it.`);
        } catch { /* no WAL file */ }
      } else {
        source = { bytes: await vscode.workspace.fs.readFile(uri) };
      }
      worker = new Worker(path.join(ctx.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
      worker.on('message', msg => {
        if (!msg) return;
        if (msg.type === 'copyResult') return onCopy(msg);
        if (msg.type === 'exportResult') return onExport(msg);
        if (msg.type === 'error' && !msg.transient) { fatal = msg; }
        toWebview(msg);
      });
      worker.on('error', e => failHost(`The reader stopped: ${e.message}`));
      worker.on('exit', code => { if (!disposed && code !== 0 && !fatal) failHost('The reader ran out of memory or crashed. Lower sqliteTableViewer.maxFileSizeMB and reopen the file.'); });
      worker.postMessage({ type: 'open', source, options: { fileSize: stat.size, copyMaxRows: opts.copyMaxRows, exportMaxRows: opts.exportMaxRows } });
      if (warnings.length) toWebview({ type: 'warnings', warnings });
    };

    const onCopy = async msg => {
      await vscode.env.clipboard.writeText(msg.text || '');
      toWebview({ type: 'copied', rows: msg.rows, format: msg.format, truncated: !!msg.truncated });
      if (msg.truncated) vscode.window.showWarningMessage(`Copied the first ${Number(msg.rows).toLocaleString('en-US')} rows (sqliteTableViewer.copyMaxRows).`);
    };

    const startExport = async suggested => {
      if (exportTarget || !worker) return;
      let fmt = suggested;
      if (!fmt) {
        const pick = await vscode.window.showQuickPick(EXPORT_CHOICES, { title: 'Export the rows in view', placeHolder: 'Pick a format' });
        if (!pick) return;
        fmt = pick.id;
      }
      const choice = EXPORT_CHOICES.find(c => c.id === fmt);
      const base = name.replace(/\.[^.]+$/, '');
      const dir = uri.scheme === 'file' ? vscode.Uri.joinPath(uri, '..') : undefined;
      const target = await vscode.window.showSaveDialog({
        title: `Export ${choice.label}`, saveLabel: 'Export',
        defaultUri: dir ? vscode.Uri.joinPath(dir, `${base}-export.${fmt}`) : undefined,
        filters: { [choice.label]: [fmt] },
      });
      if (!target) return;
      if (target.toString() === uri.toString()) { vscode.window.showErrorMessage('Pick another file. The export never overwrites the database.'); return; }
      exportTarget = target;
      toWebview({ type: 'exporting', format: fmt });
      worker.postMessage({ type: 'export', format: fmt });
    };

    const onExport = async msg => {
      const target = exportTarget;
      exportTarget = null;
      try {
        if (!msg.ok) throw new Error(msg.error);
        await vscode.workspace.fs.writeFile(target, Buffer.from(msg.text, 'utf8'));
      } catch (e) {
        toWebview({ type: 'exported', ok: false });
        vscode.window.showErrorMessage(`Export failed: ${e.message || e}`);
        return;
      }
      toWebview({ type: 'exported', ok: true, rows: msg.rows, bytes: msg.bytes, format: msg.format, truncated: msg.truncated });
      vscode.window.showInformationMessage(`Exported ${Number(msg.rows).toLocaleString('en-US')} rows to ${path.posix.basename(target.path)}.` + (msg.truncated ? ' The export stopped at sqliteTableViewer.exportMaxRows.' : ''));
    };

    panel.onDidChangeViewState(e => { if (!e.webviewPanel.visible) webviewReady = false; });

    panel.webview.onDidReceiveMessage(async raw => {
      const msg = validateWebviewMessage(raw);
      if (!msg) return;
      if (msg.type === 'ready') {
        webviewReady = true;
        panel.webview.postMessage({ type: 'init', fileName: name, history: history() });
        if (warnings.length) panel.webview.postMessage({ type: 'warnings', warnings });
        while (queue.length) { const q = queue.shift(); if (q.type !== 'warnings') panel.webview.postMessage(q); }
        if (fatal) panel.webview.postMessage(fatal);
        else if (worker) worker.postMessage({ type: 'resync' });
        return;
      }
      if (msg.type === 'openSettings') { vscode.commands.executeCommand('workbench.action.openSettings', 'sqliteTableViewer'); return; }
      if (msg.type === 'export') { startExport(msg.format); return; }
      if (msg.type === 'runSql') {
        const h = [msg.sql.trim(), ...history().filter(s => s !== msg.sql.trim())].slice(0, HISTORY_MAX);
        await ctx.globalState.update(HISTORY_KEY, h);
        toWebview({ type: 'history', history: h });
      }
      if (worker) worker.postMessage(msg);
    });

    panel.onDidDispose(() => {
      disposed = true;
      if (worker) worker.terminate();
    });

    try { await startWorker(); } catch (e) { failHost(e.message || String(e)); }
  }
}

function activate(context) {
  const provider = new DatabaseEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('sqliteTableViewer.open', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) { vscode.window.showInformationMessage('Right-click a file in the Explorer and pick "Open in SQLite Table Viewer".'); return; }
      const head = await readHead(target);
      if (!head || sniff(head) === 'other') {
        vscode.window.showWarningMessage(`${path.posix.basename(target.path)} does not start with the "SQLite format 3" header, so it is not a SQLite database.`);
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('sqliteTableViewer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.sqlite-table-viewer#sqliteTableViewer.start', false)),
  );
  // A SQLite file with another extension (.data, .store, no extension) opens as binary text.
  // Check its header once and offer to open it here.
  const offered = new Set();
  const checkTabs = async tabs => {
    for (const tab of tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== 'file' || KNOWN_EXT.test(input.uri.path)) continue;
      const key = input.uri.toString();
      if (offered.has(key)) continue;
      offered.add(key);
      const head = await readHead(input.uri);
      if (!head || sniff(head) !== 'sqlite') continue;
      const pick = await vscode.window.showInformationMessage(`${path.posix.basename(input.uri.path)} is a SQLite database. Open it in SQLite Table Viewer?`, 'Open');
      if (pick === 'Open') await vscode.commands.executeCommand('vscode.openWith', input.uri, VIEW_TYPE);
    }
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(e => { checkTabs(e.opened); }));
  // Tabs opened before activation (onStartupFinished) get the same check.
  checkTabs(vscode.window.tabGroups.all.flatMap(g => g.tabs));
}

function deactivate() {}

module.exports = { activate, deactivate, KNOWN_EXT, VIEW_TYPE };
