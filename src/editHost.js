'use strict';
// Host side of editing mode, one per open tab: the "Enable editing" checks, Save, Checkpoint and reload,
// CSV import file picking, BLOB files, and the Pro candidate prompts (schema editing, find and replace).
// The worker does the database work; this file only talks to VS Code and the local file system.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BLOB_MAX = 64 * 1024 * 1024;

/** Other processes that have file open (macOS and Linux, through lsof). [] when unknown. */
function whoHasOpen(file, exec = execFile) {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise(resolve => {
    exec('lsof', ['-F', 'pc', '--', file, file + '-wal'], { timeout: 3000 }, (err, stdout) => {
      if (!stdout) { resolve([]); return; }
      resolve(parseLsof(String(stdout), process.pid));
    });
  });
}

function parseLsof(text, selfPid) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { cur = { pid: Number(line.slice(1)), command: '' }; if (cur.pid !== selfPid && !out.some(o => o.pid === cur.pid)) out.push(cur); }
    else if (line.startsWith('c') && cur) cur.command = line.slice(1);
  }
  return out.filter(o => o.pid && o.pid !== selfPid);
}

/** Run PRAGMA wal_checkpoint(TRUNCATE) with the sqlite3 tool. Resolves { ok, message }. */
function checkpoint(file, exec = execFile) {
  return new Promise(resolve => {
    exec('sqlite3', [file, 'PRAGMA wal_checkpoint(TRUNCATE);'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        resolve({ ok: false, missing: true, message: 'The sqlite3 tool is not installed, so the checkpoint cannot run from here. Close the app that uses the database (SQLite checkpoints when the last connection closes), then reload.' });
        return;
      }
      if (err) { resolve({ ok: false, message: `The checkpoint did not run: ${String(stderr || err.message).trim()}` }); return; }
      const m = String(stdout).trim().match(/^(\d+)\|(-?\d+)\|(-?\d+)/);
      if (m && m[1] !== '0') { resolve({ ok: false, message: 'Another connection is busy with the database, so the checkpoint could not finish. Close the app that uses it and try again.' }); return; }
      resolve({ ok: true, message: 'Checkpoint done: every committed transaction is now in the main file.' });
    });
  });
}

/** Bytes of a new, empty SQLite database: one 4096-byte page with the header and an empty schema table. */
function emptyDatabase() {
  const b = Buffer.alloc(4096);
  b.write('SQLite format 3\u0000', 0, 'latin1');
  b.writeUInt16BE(4096, 16); // page size
  b[18] = 1; b[19] = 1; // rollback journal mode
  b[20] = 0; b[21] = 64; b[22] = 32; b[23] = 32;
  b.writeUInt32BE(1, 24); // change counter
  b.writeUInt32BE(1, 28); // size in pages
  b.writeUInt32BE(4, 44); // schema format
  b.writeUInt32BE(1, 56); // UTF-8
  b.writeUInt32BE(1, 92); // version-valid-for
  b.writeUInt32BE(3045000, 96);
  b[100] = 0x0d; // leaf table b-tree page, no cells
  b.writeUInt16BE(4096, 105); // cell content area starts at the end of the page
  return b;
}

function createEditHost(o) {
  const { vscode, uri, name, toWebview, pro } = o;
  const isLocal = uri.scheme === 'file';
  const file = isLocal ? uri.fsPath : null;
  const state = { editing: false, pending: 0, source: null, columns: [], focusCol: null, importFile: null, importing: false, savedStat: null, waiters: [], blobReq: 0, blobTargets: new Map() };
  const worker = () => o.getWorker();
  const cfg = () => vscode.workspace.getConfiguration('sqliteTableViewer');

  const workerOptions = () => ({
    foreignKeys: cfg().get('enforceForeignKeys', true),
    editLimitBytes: Math.max(1, cfg().get('editMaxFileSizeMB', 256)) * 1024 * 1024,
  });

  /** Ask before editing a file another program has open. True to go on. */
  async function confirmOthers(action) {
    if (!file) return true;
    const others = await whoHasOpen(file);
    if (!others.length) return true;
    const who = others.slice(0, 3).map(p => `${p.command || 'a program'} (pid ${p.pid})`).join(', ');
    const pick = await vscode.window.showWarningMessage(`${name} is open in another program: ${who}.`, {
      modal: true,
      detail: 'If that program writes while you edit, Save refuses and keeps your changes. If it writes after you save, its writes can go to the old copy of the file. Close it first when you can.',
    }, action);
    return pick === action;
  }

  function waitEditing() {
    return new Promise(resolve => state.waiters.push(resolve));
  }

  async function enableEditing() {
    if (state.editing) return true;
    if (!isLocal) {
      toWebview({ type: 'editRefused', message: 'Editing works for database files on this computer. This one is on a remote or virtual file system, so it stays read-only.' });
      return false;
    }
    if (!(await confirmOthers('Enable editing'))) return false;
    const w = worker();
    if (!w) return false;
    const done = waitEditing();
    w.postMessage({ type: 'enableEditing', options: workerOptions() });
    return done;
  }

  async function save() {
    const w = worker();
    if (!w || !state.editing) return;
    if (state.importing) { vscode.window.showWarningMessage('Wait until the import finishes, then save.'); return; }
    if (!(await confirmOthers('Save'))) return;
    toWebview({ type: 'saving' });
    w.postMessage({ type: 'save', backup: cfg().get('backupLocation', 'nextToFile') });
  }

  async function runCheckpoint() {
    if (!file) return;
    const pick = await vscode.window.showWarningMessage(`Checkpoint ${name}?`, {
      modal: true,
      detail: 'The sqlite3 tool moves the committed transactions from the -wal file into the main file (PRAGMA wal_checkpoint(TRUNCATE)). SQLite does this itself all the time, and it does not change the data. Then the view reloads.',
    }, 'Checkpoint and reload');
    if (pick !== 'Checkpoint and reload') return;
    const r = await checkpoint(file);
    if (r.ok) { vscode.window.showInformationMessage(r.message); o.reload('manual'); } else vscode.window.showWarningMessage(r.message);
  }

  async function pickImportFile() {
    if (!isLocal) { vscode.window.showWarningMessage('CSV import works for database files on this computer.'); return; }
    if (!(await enableEditing())) return;
    const picked = await vscode.window.showOpenDialog({
      title: `Import CSV or TSV into ${name}`, openLabel: 'Preview', canSelectMany: false,
      defaultUri: vscode.Uri.joinPath(uri, '..'),
      filters: { 'CSV and TSV': ['csv', 'tsv', 'tab', 'txt', 'psv'], 'All files': ['*'] },
    });
    if (!picked || !picked[0]) return;
    if (picked[0].scheme !== 'file') { vscode.window.showWarningMessage('Pick a file on this computer.'); return; }
    state.importFile = picked[0].fsPath;
    worker().postMessage({ type: 'importPreview', file: state.importFile, options: {} });
  }

  /** "Import CSV into a new SQLite database": the new file is open, so go straight to the preview. */
  async function importFrom(csvPath) {
    if (!(await enableEditing())) return;
    state.importFile = csvPath;
    worker().postMessage({ type: 'importPreview', file: csvPath, options: {} });
  }

  async function startImport(options) {
    if (!state.importFile || state.importing) return;
    if (options.columns.some(c => c.transform && c.transform !== 'none') && !(await pro.require('transforms'))) return;
    state.importing = true;
    worker().postMessage({ type: 'importRun', options: { ...options, file: state.importFile } });
  }

  async function blobFromFile(msg) {
    const picked = await vscode.window.showOpenDialog({ title: 'Put a file into this cell as a BLOB', openLabel: 'Use file', canSelectMany: false });
    if (!picked || !picked[0]) return;
    const st = await vscode.workspace.fs.stat(picked[0]);
    if (st.size > BLOB_MAX) { vscode.window.showWarningMessage(`That file is ${(st.size / 1048576).toFixed(0)} MB. Cells take files up to 64 MB here.`); return; }
    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    worker().postMessage({ type: 'editCell', row: msg.row, col: msg.col, version: msg.version, value: new Uint8Array(bytes) });
  }

  async function blobToFile(msg) {
    const target = await vscode.window.showSaveDialog({ title: 'Save the BLOB in this cell to a file', saveLabel: 'Save', defaultUri: isLocal ? vscode.Uri.joinPath(uri, '..', 'blob.bin') : undefined });
    if (!target) return;
    if (target.toString() === uri.toString()) { vscode.window.showErrorMessage('Pick another file. This never overwrites the database.'); return; }
    const reqId = ++state.blobReq;
    state.blobTargets.set(reqId, target);
    worker().postMessage({ type: 'blobOut', reqId, row: msg.row, col: msg.col });
  }

  const tableName = () => (state.source && state.source.kind === 'table' ? state.source.name : null);

  async function pickColumn(title, preferred) {
    const cols = state.columns.filter(c => !c.generated);
    if (!cols.length) return null;
    const items = cols.map((c, i) => ({ label: c.name, description: c.declared || '', index: i }));
    if (preferred !== null && preferred !== undefined && state.columns[preferred]) {
      const at = items.findIndex(it => it.label === state.columns[preferred].name);
      if (at > 0) items.unshift(items.splice(at, 1)[0]);
    }
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick a column' });
    return pick ? pick.label : null;
  }

  const validName = v => (!v || !v.trim() ? 'Type a name.' : v.length > 200 ? 'Use at most 200 characters.' : null);

  async function schemaAction(msg) {
    const table = tableName();
    if (!table) { vscode.window.showInformationMessage('Open a table first.'); return; }
    if (!(await pro.require('schema'))) return;
    if (!(await enableEditing())) return;
    let op = null;
    if (msg.action === 'addColumn') {
      const column = await vscode.window.showInputBox({ title: `Add a column to ${table}`, prompt: 'Column name', validateInput: validName });
      if (!column) return;
      const type = await vscode.window.showQuickPick(['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB', '(no type)'], { title: `Type of ${column}` });
      if (!type) return;
      op = { op: 'addColumn', table, column: column.trim(), colType: type === '(no type)' ? '' : type };
    } else if (msg.action === 'renameColumn') {
      const column = await pickColumn(`Rename a column of ${table}`, msg.col);
      if (!column) return;
      const newName = await vscode.window.showInputBox({ title: `Rename ${table}.${column}`, value: column, prompt: 'New name', validateInput: validName });
      if (!newName || newName === column) return;
      op = { op: 'renameColumn', table, column, newName: newName.trim() };
    } else if (msg.action === 'dropColumn') {
      const column = await pickColumn(`Drop a column of ${table}`, msg.col);
      if (!column) return;
      const ok = await vscode.window.showWarningMessage(`Drop ${table}.${column}?`, { modal: true, detail: 'The column and its values go away when you save. Until then, Undo brings it back.' }, 'Drop column');
      if (ok !== 'Drop column') return;
      op = { op: 'dropColumn', table, column };
    } else if (msg.action === 'renameTable') {
      const newName = await vscode.window.showInputBox({ title: `Rename table ${table}`, value: table, prompt: 'New name', validateInput: validName });
      if (!newName || newName === table) return;
      op = { op: 'renameTable', table, newName: newName.trim() };
    }
    if (op) worker().postMessage({ type: 'schemaOp', op });
  }

  async function findReplace() {
    const table = tableName();
    if (!table) { vscode.window.showInformationMessage('Open a table first.'); return; }
    if (!(await pro.require('replace'))) return;
    if (!(await enableEditing())) return;
    const column = await pickColumn(`Find and replace in ${table}`, state.focusCol);
    if (!column) return;
    const find = await vscode.window.showInputBox({ title: `Find in ${table}.${column}`, prompt: 'Text to find', validateInput: v => (v ? null : 'Type the text to find.') });
    if (!find) return;
    const replace = await vscode.window.showInputBox({ title: `Replace "${find}" in ${table}.${column} with`, prompt: 'Replacement (can be empty)', value: '' });
    if (replace === undefined) return;
    const mode = await vscode.window.showQuickPick([
      { label: 'Inside the text, any case', id: 'ci' },
      { label: 'Inside the text, match case', id: 'cs' },
      { label: 'Whole value only', id: 'whole' },
    ], { title: 'Where to match' });
    if (!mode) return;
    worker().postMessage({ type: 'findReplace', op: { table, column, find, replace, matchCase: mode.id === 'cs', whole: mode.id === 'whole' } });
  }

  /** A message from the webview (already validated). Returns true when handled here. */
  function handle(msg) {
    switch (msg.type) {
      case 'enableEditing': enableEditing(); return true;
      case 'save': save(); return true;
      case 'checkpoint': runCheckpoint(); return true;
      case 'importCsv': pickImportFile(); return true;
      case 'importPreview': if (state.importFile) worker().postMessage({ type: 'importPreview', file: state.importFile, options: msg.options }); return true;
      case 'importRun': startImport(msg.options); return true;
      case 'blobFromFile': if (state.editing) blobFromFile(msg); return true;
      case 'blobToFile': blobToFile(msg); return true;
      case 'schemaAction': schemaAction(msg); return true;
      case 'findReplace': findReplace(); return true;
      case 'cell': state.focusCol = msg.col; return false;
      default: return false;
    }
  }

  /** A message from the worker. Returns true when it must not go on to the webview. */
  function onWorker(msg) {
    switch (msg.type) {
      case 'meta': state.source = msg.source; state.columns = msg.columns; return false;
      case 'pending': {
        const was = state.editing;
        state.editing = !!msg.editing;
        state.pending = msg.items.length;
        if (state.editing && !was) { const ws = state.waiters.splice(0); ws.forEach(r => r(true)); }
        return false;
      }
      case 'editRefused': {
        const ws = state.waiters.splice(0); ws.forEach(r => r(false));
        return false;
      }
      case 'saved': {
        state.savedStat = msg.fingerprint ? { size: msg.fingerprint.size, mtimeMs: msg.fingerprint.mtimeMs } : null;
        const b = msg.backup;
        vscode.window.showInformationMessage(`Saved ${msg.changes} change${msg.changes === 1 ? '' : 's'} to ${name}. Backup: ${path.basename(b)}`, 'Show backup').then(p => {
          if (p === 'Show backup') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(b));
        });
        if (o.onSaved) o.onSaved();
        return false;
      }
      case 'saveFailed':
        if (msg.code === 'wal') {
          vscode.window.showWarningMessage(msg.message, 'Checkpoint and reload').then(p => { if (p) runCheckpoint(); });
        } else vscode.window.showErrorMessage(msg.message);
        return false;
      case 'importDone':
        state.importing = false;
        if (msg.ok) vscode.window.showInformationMessage(`Imported ${Number(msg.rows).toLocaleString('en-US')} rows into ${msg.table} in ${(msg.ms / 1000).toFixed(1)} s. Staged: Save writes them to ${name}.` + (msg.short ? ` ${Number(msg.short).toLocaleString('en-US')} rows had fewer fields; the missing ones are NULL.` : ''));
        else if (!msg.cancelled) vscode.window.showErrorMessage(msg.message);
        return false;
      case 'blobOut': {
        const target = state.blobTargets.get(msg.reqId);
        state.blobTargets.delete(msg.reqId);
        if (!target) return true;
        if (!msg.bytes) { vscode.window.showWarningMessage('That cell does not hold a BLOB.'); return true; }
        vscode.workspace.fs.writeFile(target, msg.bytes).then(
          () => vscode.window.showInformationMessage(`Saved ${msg.bytes.length.toLocaleString('en-US')} bytes to ${path.basename(target.path)}.`),
          e => vscode.window.showErrorMessage(`Not saved: ${e.message || e}`));
        return true;
      }
      default: return false;
    }
  }

  /** The file watcher saw a change. True when it is our own save, so the view must not reload. */
  function isOwnWrite(stat) {
    const s = state.savedStat;
    return !!s && !!stat && stat.size === s.size && stat.mtimeMs === s.mtimeMs;
  }

  function fs_exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

  return {
    handle, onWorker, isOwnWrite, importFrom,
    get editing() { return state.editing; },
    get pending() { return state.pending; },
    get importing() { return state.importing; },
    walExists: () => !!file && fs_exists(file + '-wal'),
  };
}

module.exports = { createEditHost, whoHasOpen, parseLsof, checkpoint, emptyDatabase };
