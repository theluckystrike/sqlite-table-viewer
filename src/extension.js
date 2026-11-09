'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const { sniff } = require('./core/sqlutil');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createEditHost, emptyDatabase } = require('./editHost');
const { createPro } = require('./pro');
const { createProTools } = require('./proHost');

let pro = { enabled: false, isPro: () => true, require: async () => true, state: () => ({ enabled: false, licensed: true, visible: false }), onDidChange: () => ({ dispose() {} }) };
let proTools = null;

let rating = { success() {}, failure() {} };

const VIEW_TYPE = 'sqliteTableViewer.database';
const KNOWN_EXT = /\.(db|sqlite|sqlite3|db3|s3db|sl3|vscdb|gpkg)$/i;
const STATE_MESSAGES = new Set(['meta', 'view', 'rows', 'objects', 'reloaded', 'reloadFailed', 'pending', 'importProgress']);
const HISTORY_KEY = 'sqliteTableViewer.history';
const HISTORY_MAX = 20;

function settings() {
  const c = vscode.workspace.getConfiguration('sqliteTableViewer');
  return {
    maxFileSizeMB: c.get('maxFileSizeMB', 512),
    copyMaxRows: c.get('copyMaxRows', 100000),
    exportMaxRows: c.get('exportMaxRows', 1000000),
    autoReload: c.get('autoReload', true),
  };
}

const EXPORT_CHOICES = [
  { id: 'csv', label: 'CSV', description: 'comma-separated, with a header row' },
  { id: 'json', label: 'JSON', description: 'one array of objects' },
  { id: 'sql', label: 'SQL INSERT statements', description: 'one INSERT per row, for another SQLite or SQL database' },
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
  constructor(context) { this.context = context; this.pendingImports = new Map(); }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('sqliteTableViewer') };
    const uri = document.uri;
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'sqliteTableViewer'),
    });

    const opts = settings();
    let worker = null;
    let disposed = false;
    let webviewReady = false;
    let fatal = null;
    let exportTarget = null;
    let counted = false; // one success per opened tab, for the rating prompt
    const warnings = [];
    const queue = [];
    const toWebview = msg => {
      if (disposed) return;
      if (webviewReady) { panel.webview.postMessage(msg); return; }
      if (!STATE_MESSAGES.has(msg.type) && !(msg.type === 'error' && !msg.transient)) queue.push(msg);
    };
    const editHost = createEditHost({
      vscode, uri, name, pro, toWebview: m => toWebview(m), getWorker: () => worker,
      reload: r => reload(r),
    });
    const failHost = message => { fatal = { type: 'error', message }; rating.failure(); toWebview(fatal); };
    const history = () => ctx.globalState.get(HISTORY_KEY, []);

    const startWorker = async () => {
      const limit = opts.maxFileSizeMB * 1024 * 1024;
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > limit) {
        throw new Error(`This database is ${(stat.size / 1048576).toFixed(0)} MB. SQLite Editor loads the whole file into memory, and the limit is ${opts.maxFileSizeMB} MB (setting sqliteTableViewer.maxFileSizeMB). Open a smaller copy, or raise the limit if this machine has the memory.`);
      }
      const source = await readSource();
      worker = new Worker(path.join(ctx.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
      worker.on('message', msg => {
        if (!msg) return;
        if (msg.type === 'copyResult') return onCopy(msg);
        if (editHost.onWorker(msg)) return;
        if (msg.type === 'exportResult') return onExport(msg);
        if (msg.type === 'error' && !msg.transient) { fatal = msg; rating.failure(); }
        if (msg.type === 'opened' || msg.type === 'reloaded') lastWal = msg.wal || null;
        if (msg.type === 'reloaded' || msg.type === 'reloadFailed') reloadDone(msg);
        if (msg.type === 'meta' && !counted && !fatal) { counted = true; rating.success(uri); }
        if (msg.type === 'objects' && this.pendingImports.has(uri.toString())) {
          const csv = this.pendingImports.get(uri.toString());
          this.pendingImports.delete(uri.toString());
          editHost.importFrom(csv);
        }
        toWebview(msg);
      });
      worker.on('error', e => failHost(`The reader stopped: ${e.message}`));
      worker.on('exit', code => { if (!disposed && code !== 0 && !fatal) failHost('The reader ran out of memory or crashed. Lower sqliteTableViewer.maxFileSizeMB and reopen the file.'); });
      worker.postMessage({ type: 'open', source, options: workerOptions(stat.size) });
      if (warnings.length) toWebview({ type: 'warnings', warnings });
    };

    const workerOptions = size => ({ fileSize: size, copyMaxRows: opts.copyMaxRows, exportMaxRows: opts.exportMaxRows });
    // Local files are read by the worker itself (with their -wal). Other file systems are read here.
    const readSource = async () => {
      if (uri.scheme === 'file') return { path: uri.fsPath };
      const bytes = await vscode.workspace.fs.readFile(uri);
      let wal = null;
      try { wal = await vscode.workspace.fs.readFile(uri.with({ path: uri.path + '-wal' })); } catch { /* no WAL file */ }
      return { bytes, wal };
    };

    // ---------- reload when the file or its -wal changes ----------
    let lastWal = null;
    let reloading = false;
    let reloadAgain = null;
    let retried = false;
    const reload = async reason => {
      if (!worker || fatal || disposed) return;
      if (editHost.editing || editHost.importing) { toWebview({ type: 'reloadFailed', message: 'Editing is on. Save or discard your changes, then reload.', editing: true }); return; }
      if (reloading) { reloadAgain = reason; return; }
      reloading = true;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > opts.maxFileSizeMB * 1024 * 1024) throw new Error(`The file grew past ${opts.maxFileSizeMB} MB (sqliteTableViewer.maxFileSizeMB), so it was not reloaded.`);
        worker.postMessage({ type: 'reload', reason, source: await readSource(), options: workerOptions(stat.size) });
      } catch (e) {
        reloading = false;
        toWebview({ type: 'reloadFailed', message: e.message || String(e) });
      }
    };
    const reloadDone = msg => {
      reloading = false;
      if (msg.type === 'reloadFailed' && !retried && !reloadAgain) {
        // A write in progress can leave the file half-updated for a moment. Try once more.
        retried = true;
        setTimeout(() => reload('file'), 1500);
        return;
      }
      retried = false;
      if (reloadAgain) { const r = reloadAgain; reloadAgain = null; reload(r); }
    };
    let changeTimer = null;
    const onFileChange = () => {
      if (disposed) return;
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        // While editing, a reload would drop the staged changes. Show the notice; Save refuses a changed file anyway.
        if (editHost.editing || editHost.importing) toWebview({ type: 'fileChanged', editing: true });
        else if (settings().autoReload) reload('file');
        else toWebview({ type: 'fileChanged' });
      }, 300);
    };
    const watchers = [];
    try {
      if (uri.scheme === 'file') {
        // A stat of the database and its -wal once a second. VS Code's file watcher and fs.watch both
        // missed writes from another process on macOS (VS Code 1.142, a Python WAL writer), so poll.
        for (const f of [uri.fsPath, uri.fsPath + '-wal']) {
          const onStat = (cur, prev) => {
          if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
          if (f === uri.fsPath && editHost.isOwnWrite(cur)) return; // our own Save
          onFileChange();
        };
          fs.watchFile(f, { interval: 1000, persistent: false }, onStat);
          watchers.push({ dispose: () => fs.unwatchFile(f, onStat) });
        }
      } else {
        const dirUri = vscode.Uri.joinPath(uri, '..');
        for (const f of [name, name + '-wal']) {
          const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirUri, f));
          watchers.push(w, w.onDidChange(onFileChange), w.onDidCreate(onFileChange), w.onDidDelete(onFileChange));
        }
      }
    } catch { /* this file system cannot be watched; the Reload button still works */ }

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
        // proEnabled stays false: the 0.3.0 table tools it marked are free. The 0.4.0 Pro tools use the 'pro' message.
        panel.webview.postMessage({ type: 'init', fileName: name, history: history(), canEdit: uri.scheme === 'file', proEnabled: false, isPro: true });
        panel.webview.postMessage({ type: 'pro', ...pro.state(), local: uri.scheme === 'file' });
        if (warnings.length) panel.webview.postMessage({ type: 'warnings', warnings });
        panel.webview.postMessage({ type: 'settings', autoReload: settings().autoReload });
        if (lastWal) panel.webview.postMessage({ type: 'wal', wal: lastWal });
        while (queue.length) { const q = queue.shift(); if (q.type !== 'warnings') panel.webview.postMessage(q); }
        if (fatal) panel.webview.postMessage(fatal);
        else if (worker) worker.postMessage({ type: 'resync' });
        return;
      }
      if (msg.type === 'openSettings') { vscode.commands.executeCommand('workbench.action.openSettings', 'sqliteTableViewer'); return; }
      if (msg.type === 'reload') { reload('manual'); return; }
      if (msg.type === 'setAutoReload') {
        await vscode.workspace.getConfiguration('sqliteTableViewer').update('autoReload', msg.on, vscode.ConfigurationTarget.Global);
        toWebview({ type: 'settings', autoReload: msg.on });
        if (msg.on) reload('manual');
        return;
      }
      if (msg.type === 'export') { startExport(msg.format); return; }
      if (msg.type === 'proTools') { if (proTools) proTools.pick(uri); return; }
      if (editHost.handle(msg)) return;
      if (msg.type === 'runSql') {
        const h = [msg.sql.trim(), ...history().filter(s => s !== msg.sql.trim())].slice(0, HISTORY_MAX);
        await ctx.globalState.update(HISTORY_KEY, h);
        toWebview({ type: 'history', history: h });
      }
      if (worker) worker.postMessage(msg);
    });

    const proSub = pro.onDidChange(s => { if (!disposed) panel.webview.postMessage({ type: 'pro', ...s, local: uri.scheme === 'file' }); });
    panel.onDidDispose(() => {
      proSub.dispose();
      if (editHost.pending > 0) {
        vscode.window.showWarningMessage(`${name} was closed with ${editHost.pending} unsaved change${editHost.pending === 1 ? '' : 's'}. They were dropped, and the file was not changed.`);
      }
      disposed = true;
      clearTimeout(changeTimer);
      watchers.forEach(w => w.dispose());
      if (worker) worker.terminate();
    });

    try { await startWorker(); } catch (e) { failHost(e.message || String(e)); }
  }
}

function activate(context) {
  pro = createPro({ vscode, context });
  proTools = createProTools({ vscode, pro, extensionPath: context.extensionPath });
  proTools.register(context);
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.sqlite-table-viewer', section: 'sqliteTableViewer', name: 'SQLite Editor' });
  registerSupport({ vscode, context, prefix: 'sqliteTableViewer', selfId: 'zovo.sqlite-table-viewer' });
  const provider = new DatabaseEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: true }),
    vscode.commands.registerCommand('sqliteTableViewer.open', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) { vscode.window.showInformationMessage('Right-click a file in the Explorer and pick "Open in SQLite Editor".'); return; }
      const head = await readHead(target);
      if (!head || sniff(head) === 'other') {
        vscode.window.showWarningMessage(`${path.posix.basename(target.path)} does not start with the "SQLite format 3" header, so it is not a SQLite database.`);
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('sqliteTableViewer.csvToNewDatabase', async arg => {
      let csv = arg instanceof vscode.Uri ? arg : null;
      if (!csv) {
        const picked = await vscode.window.showOpenDialog({ title: 'Pick a CSV or TSV file to import into a new SQLite database', openLabel: 'Pick CSV', canSelectMany: false, filters: { 'CSV and TSV': ['csv', 'tsv', 'tab', 'txt', 'psv'], 'All files': ['*'] } });
        csv = picked && picked[0];
      }
      if (!csv) return;
      if (csv.scheme !== 'file') { vscode.window.showWarningMessage('Pick a file on this computer.'); return; }
      const target = await vscode.window.showSaveDialog({
        title: 'Name the new SQLite database', saveLabel: 'Create database',
        defaultUri: vscode.Uri.file(csv.fsPath.replace(/\.[^.\\/]+$/, '') + '.db'), filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3'] },
      });
      if (!target) return;
      if (target.scheme !== 'file') { vscode.window.showWarningMessage('Pick a folder on this computer.'); return; }
      if (fs.existsSync(target.fsPath)) {
        vscode.window.showWarningMessage(`${path.basename(target.fsPath)} already exists. Open it and use Import CSV to add a table, or pick a new name.`);
        return;
      }
      fs.writeFileSync(target.fsPath, emptyDatabase(), { flag: 'wx' });
      provider.pendingImports.set(target.toString(), csv.fsPath);
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
      const pick = await vscode.window.showInformationMessage(`${path.posix.basename(input.uri.path)} is a SQLite database. Open it in SQLite Editor?`, 'Open');
      if (pick === 'Open') await vscode.commands.executeCommand('vscode.openWith', input.uri, VIEW_TYPE);
    }
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(e => { checkTabs(e.opened); }));
  // Tabs opened before activation (onStartupFinished) get the same check.
  checkTabs(vscode.window.tabGroups.all.flatMap(g => g.tabs));
}

function deactivate() {}

module.exports = { activate, deactivate, KNOWN_EXT, VIEW_TYPE, DatabaseEditorProvider };
