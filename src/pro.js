'use strict';
// Zovo Pro switch for SQLite Editor. PRO_ENABLED = false at ship: every feature is free, no license command shows,
// and nothing here touches the network. To sell the Pro candidates later (schema editing, find and replace across a
// column, CSV import with column transforms), set PRO_ENABLED = true. Then the shared license module in
// src/license (GitHub Sponsors rail + offline Ed25519 key rail, factory/sprint/license) decides, and the commands
// listed in package.json appear (context key sqliteTableViewer.proEnabled).
// Opening, viewing, cell edits, rows, Save, the SQL box and plain CSV import are free forever.

const PRO_ENABLED = false;
const SKU = 'sqlite-pro';

const FEATURES = {
  schema: ['Schema editing', 'Add, rename and drop columns and rename tables, staged with Undo like every other change.'],
  replace: ['Find and replace in a column', 'Replace text across every row of a column in one staged change.'],
  transforms: ['CSV import with column transforms', 'Trim, lower case, upper case, empty to NULL and number clean-up while the rows go in.'],
};

function createPro({ vscode, context, enabled = PRO_ENABLED, license = null }) {
  let lic = license;
  if (enabled && !lic) {
    // eslint-disable-next-line global-require
    const { createLicense } = require('./license');
    lic = createLicense({ vscode, context, sku: SKU, name: 'SQLite Editor', commandPrefix: 'sqliteTableViewer' });
  }
  if (vscode.commands && vscode.commands.executeCommand) vscode.commands.executeCommand('setContext', 'sqliteTableViewer.proEnabled', !!enabled);
  return {
    enabled: !!enabled,
    sku: SKU,
    isPro: () => !enabled || !!(lic && lic.isPro(SKU)),
    /** True when the feature may run. Free build: always. Pro build: the license decides (one modal, user-started). */
    async require(key) {
      if (!enabled) return true;
      const [name, detail] = FEATURES[key] || [key, ''];
      return lic.requirePro(name, detail);
    },
  };
}

module.exports = { createPro, PRO_ENABLED, SKU, FEATURES };
