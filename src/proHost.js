'use strict';
// The Zovo Pro tools in VS Code: commands, dialogs, progress and the worker (dist/proworker.js) that does the work.
// Every tool starts from a user action (the "DB tools" button in the editor, a command or the Explorer menu).
// A free try is used only after the tool wrote its files. Escape in any dialog, Cancel or an error costs nothing.
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const VIEW_TYPE = 'sqliteTableViewer.database';
const DB_FILTERS = { 'SQLite database': ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3', 'vscdb', 'gpkg'], 'All files': ['*'] };
const stem = p => path.basename(p).replace(/\.[^.]+$/, '') || path.basename(p);

function createProTools({ vscode, pro, extensionPath }) {
  const cfg = () => vscode.workspace.getConfiguration('sqliteTableViewer');
  const maxBytes = () => cfg().get('maxFileSizeMB', 512) * 1024 * 1024;

  /** The database for a tool: the Explorer item, else the SQLite Editor tab in front, else ask. */
  async function resolveDb(arg, title) {
    if (arg && typeof arg === 'object' && typeof arg.scheme === 'string' && typeof arg.fsPath === 'string') return arg; // Explorer item or editor
    const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE) return tab.input.uri;
    const picked = await vscode.window.showOpenDialog({ title, openLabel: 'Pick database', canSelectMany: false, filters: DB_FILTERS });
    return picked && picked[0];
  }

  const local = uri => {
    if (uri.scheme === 'file') return true;
    vscode.window.showWarningMessage('The Pro tools work with database files on this computer. Copy the file to a local folder first.');
    return false;
  };

  /** Runs one job in a fresh worker with a cancellable progress notification. Resolves { ok, result | error | cancelled }. */
  function runJob(title, job, partFiles) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_p, token) => new Promise(resolve => {
      const w = new Worker(path.join(extensionPath, 'dist', 'proworker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
      let finished = false;
      const end = r => { if (finished) return; finished = true; w.terminate(); resolve(r); };
      token.onCancellationRequested(() => {
        end({ ok: false, cancelled: true });
        for (const f of partFiles) { try { fs.unlinkSync(`${f}.${process.pid}.part`); } catch { /* none */ } }
      });
      w.on('message', m => end(m));
      w.on('error', e => end({ ok: false, error: e.message }));
      w.on('exit', code => end({ ok: false, error: code ? 'The worker ran out of memory. Lower sqliteTableViewer.maxFileSizeMB or use smaller copies.' : 'The worker stopped.' }));
      w.postMessage(job);
    }));
  }

  const failed = (tool, r) => {
    if (r.cancelled) return;
    vscode.window.showErrorMessage(`${pro.TOOLS[tool].name} failed: ${r.error}`);
  };

  async function openSide(files) {
    for (let i = 0; i < files.length; i++) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(files[i]));
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: i === 0 ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside });
    }
  }

  async function compare(arg) {
    const a = await resolveDb(arg, 'Pick the first database (A)');
    if (!a || !local(a)) return false;
    if (!(await pro.allow('compare'))) return false;
    const picked = await vscode.window.showOpenDialog({
      title: `Compare ${path.basename(a.fsPath)} (A) with… (B)`, openLabel: 'Compare with this database', canSelectMany: false,
      defaultUri: vscode.Uri.file(path.dirname(a.fsPath)), filters: DB_FILTERS,
    });
    const b = picked && picked[0];
    if (!b || !local(b)) return false;
    if (b.fsPath === a.fsPath) { vscode.window.showWarningMessage('Pick another database. A and B are the same file.'); return false; }
    const base = `${stem(a.fsPath)}-vs-${stem(b.fsPath)}`;
    const target = await vscode.window.showSaveDialog({
      title: `Save the compare report (the sync script goes next to it as ${base}-sync.sql)`, saveLabel: 'Compare and save',
      defaultUri: vscode.Uri.file(path.join(path.dirname(a.fsPath), `${base}-compare.md`)), filters: { Markdown: ['md'] },
    });
    if (!target) return false;
    const report = target.fsPath;
    const script = report.replace(/(-compare)?\.md$/i, '') + '-sync.sql';
    if ([a.fsPath, b.fsPath].includes(report) || [a.fsPath, b.fsPath].includes(script)) { vscode.window.showErrorMessage('Pick another name. The report never overwrites a database.'); return false; }
    const r = await runJob(`Comparing ${path.basename(a.fsPath)} with ${path.basename(b.fsPath)}`, {
      type: 'compare', a: a.fsPath, b: b.fsPath, report, script, maxBytes: maxBytes(), maxStatements: cfg().get('compareMaxStatements', 1000000),
    }, [report, script]);
    if (!r.ok) { failed('compare', r); return false; }
    await pro.spend('compare');
    await openSide([report, script]);
    const s = r.result.summary;
    const n = x => Number(x).toLocaleString('en-US');
    vscode.window.showInformationMessage(r.result.same
      ? `${path.basename(a.fsPath)} and ${path.basename(b.fsPath)} have the same schema and rows.`
      : `Compared in ${n(r.result.ms)} ms: ${n(s.rowsOnlyA)} rows only in A, ${n(s.rowsOnlyB)} only in B, ${n(s.rowsChanged)} differ; ${s.tablesOnlyA + s.tablesOnlyB + s.tablesChanged} table differences. The sync script was not run.`);
    return true;
  }

  async function erd(arg) {
    const db = await resolveDb(arg, 'Pick the database for the ER diagram');
    if (!db || !local(db)) return false;
    if (!(await pro.allow('erd'))) return false;
    const base = stem(db.fsPath);
    const target = await vscode.window.showSaveDialog({
      title: `Save the schema document (the diagram goes next to it as ${base}-er.svg and ${base}-er.mmd)`, saveLabel: 'Save',
      defaultUri: vscode.Uri.file(path.join(path.dirname(db.fsPath), `${base}-schema.md`)), filters: { Markdown: ['md'] },
    });
    if (!target) return false;
    const md = target.fsPath;
    const stemOut = md.replace(/(-schema)?\.md$/i, '');
    const svg = `${stemOut}-er.svg`;
    const mmd = `${stemOut}-er.mmd`;
    if ([md, svg, mmd].includes(db.fsPath)) { vscode.window.showErrorMessage('Pick another name. The document never overwrites the database.'); return false; }
    const r = await runJob(`Reading the schema of ${path.basename(db.fsPath)}`, { type: 'erd', db: db.fsPath, md, svg, mmd, maxBytes: maxBytes() }, [md, svg, mmd]);
    if (!r.ok) { failed('erd', r); return false; }
    await pro.spend('erd');
    await openSide([md]);
    const pick = await vscode.window.showInformationMessage(`Wrote the schema document and the ER diagram: ${r.result.tables} tables, ${r.result.fks} foreign keys.`, 'Open SVG', 'Show in folder');
    if (pick === 'Open SVG') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(svg));
    if (pick === 'Show in folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(svg));
    return true;
  }

  async function exportAll(arg) {
    const db = await resolveDb(arg, 'Pick the database to export');
    if (!db || !local(db)) return false;
    if (!(await pro.allow('exportAll'))) return false;
    const fmt = await vscode.window.showQuickPick([
      { id: 'xlsx', label: 'Excel workbook (.xlsx)', description: 'one sheet per table, bold frozen header row' },
      { id: 'csv', label: 'CSV files in a folder', description: 'one file per table, with a header row' },
    ], { title: `Export every table of ${path.basename(db.fsPath)}`, placeHolder: 'Pick a format' });
    if (!fmt) return false;
    const base = stem(db.fsPath);
    let out;
    if (fmt.id === 'xlsx') {
      const t = await vscode.window.showSaveDialog({ title: 'Save the workbook', saveLabel: 'Export', defaultUri: vscode.Uri.file(path.join(path.dirname(db.fsPath), `${base}.xlsx`)), filters: { 'Excel workbook': ['xlsx'] } });
      if (!t) return false;
      out = t.fsPath;
    } else {
      const t = await vscode.window.showOpenDialog({ title: `Pick a folder: the CSV files go into a new folder ${base}-csv in it`, openLabel: 'Export here', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(db.fsPath)) });
      if (!t || !t[0]) return false;
      out = path.join(t[0].fsPath, `${base}-csv`);
    }
    if (out === db.fsPath) { vscode.window.showErrorMessage('Pick another name. The export never overwrites the database.'); return false; }
    const r = await runJob(`Exporting every table of ${path.basename(db.fsPath)}`, { type: 'exportAll', db: db.fsPath, format: fmt.id, out, maxRows: cfg().get('exportMaxRows', 1000000), maxBytes: maxBytes() }, fmt.id === 'xlsx' ? [out] : []);
    if (!r.ok) { failed('exportAll', r); return false; }
    await pro.spend('exportAll');
    const rows = r.result.tables.reduce((n, t) => n + t.rows, 0);
    const cut = r.result.tables.filter(t => t.truncated).map(t => t.table);
    const pick = await vscode.window.showInformationMessage(
      `Exported ${r.result.tables.length} tables (${rows.toLocaleString('en-US')} rows) to ${path.basename(out)}.` + (cut.length ? ` Stopped at the row limit in: ${cut.join(', ')}.` : ''),
      'Show in folder');
    if (pick === 'Show in folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fmt.id === 'xlsx' ? out : r.result.files[0] || out));
    return true;
  }

  /** One list of the Pro tools, from the editor button or the Explorer menu. */
  async function pick(arg) {
    const left = tool => {
      if (pro.has()) return 'Zovo Pro';
      const n = pro.triesLeft(tool);
      return n > 0 ? `Zovo Pro, ${n} free ${n === 1 ? 'try' : 'tries'} left` : 'Zovo Pro';
    };
    const items = [
      { id: 'compare', label: '$(diff) Compare with another database…', description: left('compare'), detail: 'Schema and rows, matched by primary key. A Markdown report and a SQL sync script (never run for you).' },
      { id: 'erd', label: '$(type-hierarchy) ER diagram and schema document…', description: left('erd'), detail: 'SVG and Mermaid diagram of tables and foreign keys, and a Markdown document of every table.' },
      { id: 'exportAll', label: '$(table) Export all tables…', description: left('exportAll'), detail: 'One Excel workbook with a sheet per table, or one CSV file per table.' },
    ];
    const p = await vscode.window.showQuickPick(items, { title: 'SQLite Editor Pro tools', placeHolder: 'Pick a tool' });
    if (!p) return false;
    return ({ compare, erd, exportAll })[p.id](arg);
  }

  function register(context) {
    context.subscriptions.push(
      vscode.commands.registerCommand('sqliteTableViewer.proTools', arg => pick(arg)),
      vscode.commands.registerCommand('sqliteTableViewer.compareDatabases', arg => compare(arg)),
      vscode.commands.registerCommand('sqliteTableViewer.erDiagram', arg => erd(arg)),
      vscode.commands.registerCommand('sqliteTableViewer.exportAllTables', arg => exportAll(arg)),
    );
  }

  return { pick, compare, erd, exportAll, register, resolveDb };
}

module.exports = { createProTools };
