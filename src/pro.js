'use strict';
// Zovo Pro for SQLite Editor (0.4.0). Three new Pro tools: compare two databases (schema and rows, a Markdown
// report and a SQL sync script that is never run here), ER diagram and schema document (SVG, Mermaid, Markdown),
// and export every table in one go (an Excel workbook or one CSV file per table).
//
// Each Pro tool can be used 3 times for free on this computer. A try counts only when the tool wrote its files:
// Escape in a dialog or an error costs nothing. After the 3 tries, starting the tool shows one explanation with the
// ways to unlock (GitHub Sponsors, PayPal for a key, or a key; all from the shared module in src/license). Nothing
// about Pro shows when a database opens, and there is no timer and no reminder.
//
// Free forever, as in 0.3.0: opening, viewing, sorting, filtering, the SQL box, editing cells and rows, Save with a
// backup, CSV import (with column transforms), export of the rows in view, and the table tools (add, rename and drop
// columns, rename tables, find and replace). The old FEATURES keys below stay free: require() always says yes.
//
// sqliteTableViewer.showProFeatures = false hides the Pro button and commands unless a license is active.
const { createLicense } = require('./license');

const PRO_ENABLED = true;
const SKU = 'sqlite-pro';
const FREE_TRIES = 3;
const TRIES_KEY = 'sqliteTableViewer.proTries';
const SECTION = 'sqliteTableViewer';

// 0.3.0 table tools that were "Pro candidates". They are free and stay free.
const FEATURES = {
  schema: ['Schema editing', 'Add, rename and drop columns and rename tables.'],
  replace: ['Find and replace in a column', 'Replace text across every row of a column.'],
  transforms: ['CSV import with column transforms', 'Trim, lower case, upper case, empty to NULL and number clean-up.'],
};

// The Pro tools of 0.4.0.
const TOOLS = {
  compare: { name: 'Compare databases', detail: 'Compares the tables, columns, indexes, views, triggers and rows of two SQLite databases and writes a Markdown report and a SQL script that makes the second one match the first.' },
  erd: { name: 'ER diagram and schema document', detail: 'Writes an ER diagram (SVG and Mermaid) and a Markdown document of every table, column, key, index and trigger.' },
  exportAll: { name: 'Export all tables', detail: 'Writes every table to one Excel workbook (one sheet per table) or to one CSV file per table.' },
};

const PRICE_LINE = 'Zovo Pro is USD 19 once and unlocks the Pro tools in every Zovo extension. Everything that was free stays free: opening, editing, Save, the SQL box, CSV import and export of the rows in view.';

function createPro({ vscode, context, enabled = PRO_ENABLED, license, tries = FREE_TRIES }) {
  let lic = license || null;
  if (enabled && !lic) lic = createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: 'SQLite Editor', proTools: Object.values(TOOLS).map(x => x.name), commandPrefix: SECTION });
  const showSetting = () => {
    try { return vscode.workspace.getConfiguration(SECTION).get('showProFeatures', true) !== false; } catch { return true; }
  };
  const licensed = () => { if (!enabled) return true; try { return !!lic.isPro(SKU); } catch { return false; } };
  const listeners = new Set();
  const state = () => ({ enabled: !!enabled, licensed: !!enabled && licensed(), visible: !enabled || licensed() || showSetting() });
  function publish() {
    const s = state();
    const run = (k, v) => { try { const r = vscode.commands.executeCommand('setContext', k, v); if (r && r.catch) r.catch(() => {}); } catch { /* tests */ } };
    run(`${SECTION}.proEnabled`, s.enabled);
    run(`${SECTION}.proLicensed`, s.licensed);
    run(`${SECTION}.proVisible`, s.visible);
    for (const fn of listeners) { try { fn(s); } catch { /* listener error */ } }
  }
  publish();
  if (enabled && lic) {
    if (vscode.window && vscode.window.registerUriHandler && context.subscriptions) {
      try { context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: uri => lic.handleUri(uri) })); } catch { /* another handler */ }
    }
    if (typeof lic.onDidChange === 'function') lic.onDidChange(() => publish());
    Promise.resolve(lic.ready).then(publish, () => {});
  }
  if (vscode.workspace && vscode.workspace.onDidChangeConfiguration && context.subscriptions) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(`${SECTION}.showProFeatures`)) publish(); }));
  }

  const used = tool => { const t = (context.globalState && context.globalState.get(TRIES_KEY, {})) || {}; return Number(t[tool] || 0); };

  return {
    enabled: !!enabled,
    sku: SKU,
    FREE_TRIES: tries,
    TOOLS,
    license: lic,
    state,
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    /** True: every 0.3.0 feature is free. Kept for the old call sites in editHost.js. */
    isPro: () => true,
    async require() { return true; },
    /** Pro unlocked (or Pro switched off, which makes every tool free). */
    has: () => licensed(),
    triesLeft: tool => (licensed() ? Infinity : Math.max(0, tries - used(tool))),
    /**
     * The user started a Pro tool. True when it may run: unlocked, a free try is left (not used yet: spend() uses it
     * after the files are written), or the user unlocked Pro in the dialog. The dialog shows only with no try left.
     */
    async allow(tool) {
      if (!enabled) return true;
      try { await lic.ready; } catch { /* cache unreadable: treated as not Pro */ }
      const t = TOOLS[tool] || { name: tool, detail: '' };
      if (licensed()) return lic.requirePro(t.name, { detail: t.detail }); // refreshes a monthly sponsorship when it is due; no dialog
      if (used(tool) < tries) return true;
      // EXEC14: the shared module (buy path v2) adds the price, the other Pro tools, the count and "stays free".
      return lic.requirePro(t.name, { detail: t.detail, triesUsed: tries });
    },
    /** The tool wrote its files: use one free try (nothing when Pro is unlocked). Returns the tries left. */
    async spend(tool) {
      if (!enabled || licensed()) return Infinity;
      const t = Object.assign({}, context.globalState.get(TRIES_KEY, {}));
      t[tool] = Number(t[tool] || 0) + 1;
      await context.globalState.update(TRIES_KEY, t);
      const left = Math.max(0, tries - t[tool]);
      const name = (TOOLS[tool] || { name: tool }).name;
      if (vscode.window && vscode.window.setStatusBarMessage) {
        vscode.window.setStatusBarMessage(`SQLite Editor: ${name} is a Zovo Pro tool. Free try ${Math.min(t[tool], tries)} of ${tries} used${left ? ` (${left} left)` : ', that was the last one'}.`, 10000);
      }
      return left;
    },
  };
}

module.exports = { createPro, PRO_ENABLED, SKU, FEATURES, TOOLS, FREE_TRIES, TRIES_KEY, PRICE_LINE };
