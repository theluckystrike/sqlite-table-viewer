'use strict';
// Zovo Pro tools of SQLite Editor 0.4.0. Pure functions over sql.js databases, so the tests run them in Node.
// - compareDatabases: schema and data compare of database A (the one you started from) and B (the other one), a
//   Markdown report and a SQL script that makes B match A. The script is written to a file and never run here.
// - schemaModel, erMermaid, erSvg, schemaMarkdown: ER diagram (SVG and Mermaid) and a Markdown schema document.
// - workbookParts, csvTables: every table in one Excel workbook, or one CSV file per table.
// Nothing here touches the network or writes to a database.
const U = require('./sqlutil');

const q = U.quoteIdent;
const B_SCHEMA = 'zovo_b';

function rowsOf(db, sql, params) {
  const st = db.prepare(sql);
  const out = [];
  try {
    if (params) st.bind(params);
    while (st.step()) out.push(st.getAsObject());
  } finally { st.free(); }
  return out;
}

/** Calls fn(row array) for each row without keeping them; returns the count. */
function eachRow(db, sql, fn) {
  const st = db.prepare(sql);
  let n = 0;
  try {
    while (st.step()) { n++; if (fn(st.get(), n) === false) break; }
  } finally { st.free(); }
  return n;
}

const norm = s => String(s || '').replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').replace(/;$/, '').trim().toLowerCase();

// ---------- schema ----------

/** Tables, views, indexes and triggers of the main schema, with columns, keys and foreign keys. */
function readSchema(db, opts = {}) {
  const list = new Map(rowsOf(db, "SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main'").map(r => [r.name, r]));
  const master = rowsOf(db, "SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  const tables = new Map();
  const others = { index: new Map(), view: new Map(), trigger: new Map() };
  for (const m of master) {
    if (m.type === 'table') {
      const info = list.get(m.name) || { type: 'table', wr: 0 };
      const kind = info.type === 'virtual' ? 'virtual' : info.type === 'shadow' ? 'shadow' : 'table';
      let columns = [];
      try {
        columns = rowsOf(db, 'SELECT cid, name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid', [m.name])
          .map(c => ({ name: c.name, type: c.type || '', notnull: !!c.nn, dflt: c.dflt, pk: c.pk || 0, hidden: c.hidden || 0 }));
      } catch { columns = []; }
      let fks = [];
      if (kind === 'table') {
        const raw = rowsOf(db, 'SELECT id, seq, "table" AS ref, "from" AS col, "to" AS refcol, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq', [m.name]);
        const byId = new Map();
        for (const r of raw) {
          if (!byId.has(r.id)) byId.set(r.id, { cols: [], ref: r.ref, refCols: [], onDelete: r.on_delete, onUpdate: r.on_update });
          const f = byId.get(r.id);
          f.cols.push(r.col);
          f.refCols.push(r.refcol);
        }
        fks = [...byId.values()];
      }
      const pk = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
      tables.set(m.name, { name: m.name, sql: m.sql || '', kind, withoutRowid: !!info.wr, columns, fks, pk, indexes: [], triggers: [], rows: null });
    } else if (others[m.type]) {
      others[m.type].set(m.name, { name: m.name, type: m.type, tbl: m.tbl, sql: m.sql || '' });
    }
  }
  // Indexes with their columns, including the automatic ones of UNIQUE and PRIMARY KEY constraints.
  for (const t of tables.values()) {
    if (t.kind !== 'table') continue;
    for (const ix of rowsOf(db, 'SELECT name, "unique" AS u, origin, partial FROM pragma_index_list(?)', [t.name])) {
      const cols = rowsOf(db, 'SELECT name FROM pragma_index_info(?) ORDER BY seqno', [ix.name]).map(c => (c.name === null ? '(expression)' : c.name));
      t.indexes.push({ name: ix.name, unique: !!ix.u, origin: ix.origin, partial: !!ix.partial, cols });
    }
    t.indexes.sort((a, b) => (a.name < b.name ? -1 : 1));
    if (opts.counts) {
      try { t.rows = rowsOf(db, `SELECT count(*) AS n FROM ${q(t.name)}`)[0].n; } catch { t.rows = null; }
    }
  }
  for (const tr of others.trigger.values()) { const t = tables.get(tr.tbl); if (t) t.triggers.push(tr.name); }
  return { tables, indexes: others.index, views: others.view, triggers: others.trigger };
}

function columnLine(c) {
  return [c.type || '(no type)', c.pk ? `PK${c.pk > 1 ? c.pk : ''}` : '', c.notnull ? 'NOT NULL' : '', c.dflt !== null && c.dflt !== undefined ? `DEFAULT ${c.dflt}` : '', c.hidden === 2 || c.hidden === 3 ? 'GENERATED' : '']
    .filter(Boolean).join(' ');
}

/** What differs between two versions of one table: column lines, foreign keys and the CREATE text. */
function tableDiff(a, b) {
  const lines = [];
  const bc = new Map(b.columns.map(c => [c.name, c]));
  const ac = new Map(a.columns.map(c => [c.name, c]));
  for (const c of a.columns) {
    if (!bc.has(c.name)) lines.push({ what: 'column only in A', name: c.name, a: columnLine(c), b: '' });
    else if (columnLine(c) !== columnLine(bc.get(c.name))) lines.push({ what: 'column differs', name: c.name, a: columnLine(c), b: columnLine(bc.get(c.name)) });
  }
  for (const c of b.columns) if (!ac.has(c.name)) lines.push({ what: 'column only in B', name: c.name, a: '', b: columnLine(c) });
  const order = a.columns.filter(c => bc.has(c.name)).map(c => c.name).join(',') !== b.columns.filter(c => ac.has(c.name)).map(c => c.name).join(',');
  if (order) lines.push({ what: 'column order differs', name: '', a: a.columns.map(c => c.name).join(', '), b: b.columns.map(c => c.name).join(', ') });
  const fk = f => `(${f.cols.join(', ')}) -> ${f.ref}(${f.refCols.map(x => x || 'PK').join(', ')})${f.onDelete && f.onDelete !== 'NO ACTION' ? ' ON DELETE ' + f.onDelete : ''}`;
  const af = a.fks.map(fk).sort().join('; ');
  const bf = b.fks.map(fk).sort().join('; ');
  if (af !== bf) lines.push({ what: 'foreign keys differ', name: '', a: af || 'none', b: bf || 'none' });
  if (a.withoutRowid !== b.withoutRowid) lines.push({ what: 'WITHOUT ROWID differs', name: '', a: String(a.withoutRowid), b: String(b.withoutRowid) });
  if (!lines.length && norm(a.sql) !== norm(b.sql)) lines.push({ what: 'CREATE TABLE text differs (constraints)', name: '', a: '', b: '' });
  return lines;
}

/** The key that matches rows of a table in A and B, or null when there is none both sides share. */
function rowKey(a, b) {
  if (a.kind !== 'table' || b.kind !== 'table') return null;
  if (a.pk.length || b.pk.length) return a.pk.join('\u0000') === b.pk.join('\u0000') ? { cols: a.pk, rowid: false } : null;
  if (a.withoutRowid || b.withoutRowid) return null;
  return { cols: ['rowid'], rowid: true };
}

// ---------- compare ----------

const cellText = (v, max = 60) => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `BLOB ${v.length} bytes`;
  const s = String(v).replace(/\r?\n/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};
const md = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/`/g, "'");
const fmt = n => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many || one + 's'}`;

/**
 * Compare database A (main) with database B (attached here as zovo_b, file name nameB in the sql.js file system).
 * script.write(text) receives the sync script in pieces. Returns { report (Markdown), summary, statements, capped }.
 * opts: { labelA, labelB, scriptName, maxStatements (default 1,000,000), sampleRows (default 20), now }
 */
function compareDatabases(dbA, dbB, script, opts = {}) {
  const maxStatements = opts.maxStatements || 1000000;
  const sampleRows = opts.sampleRows === undefined ? 20 : opts.sampleRows;
  const labelA = opts.labelA || 'A';
  const labelB = opts.labelB || 'B';
  const sa = readSchema(dbA, { counts: true });
  const sb = readSchema(dbB, { counts: true });
  dbA.run(`ATTACH ${U.quoteValue('/' + dbB.filename)} AS ${B_SCHEMA}`);
  let statements = 0;
  let capped = false;
  const out = s => { if (!capped) script.write(s); };
  const stmt = s => {
    if (capped) return;
    if (statements >= maxStatements) { capped = true; return; }
    statements++;
    script.write(s + '\n');
  };
  const sum = { tablesOnlyA: [], tablesOnlyB: [], tablesChanged: [], tablesSame: 0, rowsOnlyA: 0, rowsOnlyB: 0, rowsChanged: 0, tablesEqualData: 0, noKey: [], objects: [] };
  const data = [];
  try {
    out(`-- Sync script from SQLite Editor (Zovo Pro): makes ${labelB} (B) match ${labelA} (A).\n`);
    out('-- Nothing ran. Read it, make a backup of B, then run it on B, for example: sqlite3 B.db < this-file.sql\n');
    out(`-- Written ${opts.now || new Date().toISOString()}.\n`);
    out('-- Foreign key checks are off while it runs, so the order of rows does not matter. Triggers of B are dropped\n-- first and the triggers of A are created at the end, so no trigger fires on the copied rows.\n\n');
    out('PRAGMA foreign_keys = OFF;\nBEGIN;\n');

    // Triggers: drop every trigger of B now, create A's at the end.
    if (sb.triggers.size) out('\n-- Triggers of B (A\'s triggers are created at the end)\n');
    for (const tr of sb.triggers.values()) stmt(`DROP TRIGGER IF EXISTS ${q(tr.name)};`);

    // Views and indexes that are only in B or differ.
    const objDiff = (kind, mapA, mapB) => {
      const res = { onlyA: [], onlyB: [], changed: [] };
      for (const [n, o] of mapA) { if (!mapB.has(n)) res.onlyA.push(o); else if (norm(o.sql) !== norm(mapB.get(n).sql)) res.changed.push(o); }
      for (const [n, o] of mapB) if (!mapA.has(n)) res.onlyB.push(o);
      sum.objects.push({ kind, ...res });
      return res;
    };
    const views = objDiff('view', sa.views, sb.views);
    const trig = objDiff('trigger', sa.triggers, sb.triggers);
    const idxA = new Map([...sa.indexes].filter(([, o]) => o.sql));
    const idxB = new Map([...sb.indexes].filter(([, o]) => o.sql));
    const idx = objDiff('index', idxA, idxB);
    if (views.onlyB.length + views.changed.length) out('\n-- Views only in B or different\n');
    for (const v of [...views.onlyB, ...views.changed]) stmt(`DROP VIEW IF EXISTS ${q(v.name)};`);

    // Tables
    const rebuilt = new Set();
    for (const [n, t] of sb.tables) if (!sa.tables.has(n) && t.kind !== 'shadow') sum.tablesOnlyB.push(t);
    for (const [n, t] of sa.tables) {
      if (t.kind === 'shadow') continue;
      const other = sb.tables.get(n);
      if (!other) { sum.tablesOnlyA.push(t); continue; }
      const diff = tableDiff(t, other);
      if (diff.length) { sum.tablesChanged.push({ table: t, other, diff }); rebuilt.add(n); } else sum.tablesSame++;
    }
    const idxDropped = new Set([...sum.tablesOnlyB.map(t => t.name), ...rebuilt]);
    const dropIdx = [...idx.onlyB, ...idx.changed].filter(o => !idxDropped.has(o.tbl));
    if (dropIdx.length) out('\n-- Indexes only in B or different\n');
    for (const o of dropIdx) stmt(`DROP INDEX IF EXISTS ${q(o.name)};`);
    if (sum.tablesOnlyB.length) out('\n-- Tables only in B\n');
    for (const t of sum.tablesOnlyB) stmt(`DROP TABLE IF EXISTS ${q(t.name)};`);

    const copyTable = (t, why) => {
      out(`\n-- ${why}: ${t.name} (${fmt(t.rows || 0)} row${t.rows === 1 ? '' : 's'} from A)\n`);
      stmt(norm(t.sql) ? t.sql.trim().replace(/;$/, '') + ';' : `-- ${t.name}: no CREATE statement`);
      if (t.kind !== 'table') return;
      const cols = t.columns.filter(c => !c.hidden);
      const withRowid = !t.pk.length && !t.withoutRowid;
      const list = (withRowid ? ['rowid'] : []).concat(cols.map(c => c.name));
      const head = `INSERT INTO ${q(t.name)} (${list.map(q).join(', ')}) VALUES (`;
      eachRow(dbA, `SELECT ${list.map(c => (c === 'rowid' && withRowid ? 'rowid' : q(c))).join(', ')} FROM main.${q(t.name)}`, r => {
        stmt(head + r.map(U.quoteValue).join(', ') + ');');
        return !capped;
      });
    };
    for (const c of sum.tablesChanged) {
      out(`\n-- ${c.table.name}: the structure differs, so B's table is replaced with A's.\n`);
      stmt(`DROP TABLE IF EXISTS ${q(c.table.name)};`);
      copyTable(c.table, 'Table rebuilt');
    }
    for (const t of sum.tablesOnlyA) {
      if (t.kind === 'virtual') { out(`\n-- ${t.name} is a virtual table: created, its rows are not copied.\n`); stmt(t.sql.trim().replace(/;$/, '') + ';'); continue; }
      copyTable(t, 'Table only in A');
    }

    // Row changes in tables with the same structure (and in rebuilt tables, for the report only).
    for (const [n, t] of sa.tables) {
      const other = sb.tables.get(n);
      if (!other || t.kind !== 'table' || other.kind !== 'table') continue;
      const key = rowKey(t, other);
      const entry = { table: n, rowsA: t.rows, rowsB: other.rows, key: key ? key.cols : null, onlyA: 0, onlyB: 0, changed: 0, samples: [], rebuilt: rebuilt.has(n) };
      data.push(entry);
      if (!key) { sum.noKey.push(n); continue; }
      const bNames = new Set(other.columns.filter(c => !c.hidden).map(c => c.name));
      const common = t.columns.filter(c => !c.hidden && bNames.has(c.name)).map(c => c.name);
      const vals = common.filter(c => !key.cols.includes(c));
      const kx = (alias, c) => (key.rowid ? `${alias}.rowid` : `${alias}.${q(c)}`);
      const join = key.cols.map(c => `${kx('b', c)} IS ${kx('a', c)}`).join(' AND ');
      const keySel = alias => key.cols.map(c => kx(alias, c)).join(', ');
      const where = r => key.cols.map((c, i) => `${key.rowid ? 'rowid' : q(c)} ${r[i] === null ? 'IS' : '='} ${U.quoteValue(r[i])}`).join(' AND ');
      const T = q(n);
      const live = !entry.rebuilt; // a rebuilt table gets all of A's rows above; here we only count
      let wrote = false;
      const section = () => { if (live && !wrote) { wrote = true; out(`\n-- Rows of ${n}\n`); } };
      const nk = key.cols.length;
      entry.onlyB = eachRow(dbA, `SELECT ${keySel('b')} FROM ${B_SCHEMA}.${T} b WHERE NOT EXISTS (SELECT 1 FROM main.${T} a WHERE ${join}) ORDER BY ${keySel('b')}`, r => {
        if (entry.samples.length < sampleRows) entry.samples.push({ kind: 'only in B', key: r.slice(0, nk) });
        if (live) { section(); stmt(`DELETE FROM ${T} WHERE ${where(r)};`); }
        return true;
      });
      if (vals.length) {
        const flags = vals.map(c => `a.${q(c)} IS NOT b.${q(c)}`);
        const sql = `SELECT ${keySel('a')}, ${vals.map(c => `a.${q(c)}, b.${q(c)}`).join(', ')}, ${flags.join(', ')} FROM main.${T} a JOIN ${B_SCHEMA}.${T} b ON ${join} WHERE ${flags.join(' OR ')} ORDER BY ${keySel('a')}`;
        entry.changed = eachRow(dbA, sql, r => {
          const diffCols = [];
          vals.forEach((c, i) => { if (r[nk + vals.length * 2 + i]) diffCols.push({ col: c, a: r[nk + i * 2], b: r[nk + i * 2 + 1] }); });
          if (entry.samples.length < sampleRows) entry.samples.push({ kind: 'changed', key: r.slice(0, nk), cols: diffCols });
          if (live) { section(); stmt(`UPDATE ${T} SET ${diffCols.map(d => `${q(d.col)} = ${U.quoteValue(d.a)}`).join(', ')} WHERE ${where(r)};`); }
          return true;
        });
      }
      const insCols = (key.rowid ? ['rowid'] : []).concat(common.filter(c => !key.rowid || c !== 'rowid'));
      const head = `INSERT INTO ${T} (${insCols.map(c => (c === 'rowid' && key.rowid ? 'rowid' : q(c))).join(', ')}) VALUES (`;
      entry.onlyA = eachRow(dbA, `SELECT ${insCols.map(c => (c === 'rowid' && key.rowid ? 'a.rowid' : `a.${q(c)}`)).join(', ')} FROM main.${T} a WHERE NOT EXISTS (SELECT 1 FROM ${B_SCHEMA}.${T} b WHERE ${join}) ORDER BY ${keySel('a')}`, r => {
        if (entry.samples.length < sampleRows) entry.samples.push({ kind: 'only in A', key: key.rowid ? [r[0]] : key.cols.map(k => r[insCols.indexOf(k)]) });
        if (live) { section(); stmt(head + r.map(U.quoteValue).join(', ') + ');'); }
        return true;
      });
      sum.rowsOnlyA += entry.onlyA;
      sum.rowsOnlyB += entry.onlyB;
      sum.rowsChanged += entry.changed;
      if (!entry.onlyA && !entry.onlyB && !entry.changed) sum.tablesEqualData++;
    }

    // Indexes, views and triggers of A.
    const createIdx = [...idx.onlyA, ...idx.changed];
    for (const n of rebuilt) for (const o of idxA.values()) if (o.tbl === n && !createIdx.includes(o)) createIdx.push(o);
    if (createIdx.length) out('\n-- Indexes of A\n');
    for (const o of createIdx) stmt(o.sql.trim().replace(/;$/, '') + ';');
    const createViews = [...views.onlyA, ...views.changed];
    if (createViews.length) out('\n-- Views of A\n');
    for (const o of createViews) stmt(o.sql.trim().replace(/;$/, '') + ';');
    if (sa.triggers.size) out('\n-- Triggers of A\n');
    for (const o of sa.triggers.values()) stmt(o.sql.trim().replace(/;$/, '') + ';');
  } finally {
    try { dbA.run(`DETACH ${B_SCHEMA}`); } catch { /* not attached */ }
  }
  if (capped) script.write(`\n-- STOPPED after ${fmt(maxStatements)} statements: the script is incomplete, so it rolls back.\nROLLBACK;\n`);
  else script.write('\nCOMMIT;\nPRAGMA foreign_keys = ON;\n-- Check B afterwards: PRAGMA foreign_key_check; PRAGMA integrity_check;\n');

  const report = compareReport({ sa, sb, sum, data, labelA, labelB, statements, capped, maxStatements, opts });
  const same = !sum.tablesOnlyA.length && !sum.tablesOnlyB.length && !sum.tablesChanged.length && !sum.rowsOnlyA && !sum.rowsOnlyB && !sum.rowsChanged
    && sum.objects.every(o => !o.onlyA.length && !o.onlyB.length && !o.changed.length);
  return {
    report, statements, capped, same,
    summary: {
      tablesOnlyA: sum.tablesOnlyA.length, tablesOnlyB: sum.tablesOnlyB.length, tablesChanged: sum.tablesChanged.length,
      rowsOnlyA: sum.rowsOnlyA, rowsOnlyB: sum.rowsOnlyB, rowsChanged: sum.rowsChanged, noKey: sum.noKey.length,
    },
  };
}

function compareReport({ sa, sb, sum, data, labelA, labelB, statements, capped, maxStatements, opts }) {
  const L = [];
  const userTables = s => [...s.tables.values()].filter(t => t.kind !== 'shadow').length;
  L.push(`# Database compare: ${md(labelA)} and ${md(labelB)}`, '');
  L.push(`- **A**: ${md(opts.pathA || labelA)} (${plural(userTables(sa), 'table')})`);
  L.push(`- **B**: ${md(opts.pathB || labelB)} (${plural(userTables(sb), 'table')})`);
  L.push(`- Written ${opts.now || new Date().toISOString()} by SQLite Editor (Zovo Pro). Both files were only read.`, '');
  L.push('## Summary', '');
  L.push('| | Count |', '| --- | ---: |');
  L.push(`| Tables only in A | ${sum.tablesOnlyA.length} |`, `| Tables only in B | ${sum.tablesOnlyB.length} |`, `| Tables whose structure differs | ${sum.tablesChanged.length} |`, `| Tables with the same structure | ${sum.tablesSame} |`);
  for (const o of sum.objects) L.push(`| ${o.kind[0].toUpperCase() + o.kind.slice(1)}es/s only in A, only in B, different | ${o.onlyA.length}, ${o.onlyB.length}, ${o.changed.length} |`.replace(/es\/s/, o.kind === 'index' ? 'es' : 's'));
  L.push(`| Rows only in A | ${fmt(sum.rowsOnlyA)} |`, `| Rows only in B | ${fmt(sum.rowsOnlyB)} |`, `| Rows that differ | ${fmt(sum.rowsChanged)} |`, `| Tables with equal rows | ${sum.tablesEqualData} |`);
  if (sum.noKey.length) L.push(`| Tables not compared row by row (no shared key) | ${sum.noKey.length} |`);
  L.push('');
  const scriptName = opts.scriptName || 'the sync script';
  if (capped) L.push(`The sync script \`${md(scriptName)}\` stopped at ${fmt(maxStatements)} statements and ends with ROLLBACK, so running it changes nothing. Compare fewer rows, or copy the database file instead.`, '');
  else L.push(`The sync script \`${md(scriptName)}\` has ${fmt(statements)} statements and makes B match A. Nothing ran: read it, back up B, then run it on B.`, '');

  L.push('## Schema', '');
  const names = arr => (arr.length ? arr.map(t => `\`${md(t.name)}\``).join(', ') : 'none');
  L.push(`- Tables only in A: ${names(sum.tablesOnlyA)}`);
  L.push(`- Tables only in B: ${names(sum.tablesOnlyB)}`);
  for (const o of sum.objects) {
    const label = o.kind === 'index' ? 'Indexes' : o.kind[0].toUpperCase() + o.kind.slice(1) + 's';
    L.push(`- ${label} only in A: ${names(o.onlyA)}; only in B: ${names(o.onlyB)}; different: ${names(o.changed)}`);
  }
  L.push('');
  for (const c of sum.tablesChanged) {
    L.push(`### ${md(c.table.name)}: structure differs`, '', 'The sync script replaces this table in B with A\'s table and A\'s rows.', '');
    L.push('| What | Column | A | B |', '| --- | --- | --- | --- |');
    for (const d of c.diff) L.push(`| ${md(d.what)} | ${md(d.name)} | ${md(d.a)} | ${md(d.b)} |`);
    L.push('');
  }

  L.push('## Rows', '');
  if (!data.length) L.push('No table is in both databases.', '');
  else {
    L.push('| Table | Key | Rows in A | Rows in B | Only in A | Only in B | Differ |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const e of data) {
      const key = e.key ? e.key.join(', ') : 'none (not compared)';
      L.push(`| ${md(e.table)}${e.rebuilt ? ' (structure differs)' : ''} | ${md(key)} | ${fmt(e.rowsA || 0)} | ${fmt(e.rowsB || 0)} | ${e.key ? fmt(e.onlyA) : '-'} | ${e.key ? fmt(e.onlyB) : '-'} | ${e.key ? fmt(e.changed) : '-'} |`);
    }
    L.push('');
    for (const e of data) {
      if (!e.samples.length) continue;
      const total = e.onlyA + e.onlyB + e.changed;
      L.push(`### ${md(e.table)}`, '', total > e.samples.length ? `First ${e.samples.length} of ${fmt(total)} differences.` : `${fmt(total)} difference${total === 1 ? '' : 's'}.`, '');
      L.push(`| ${md(e.key.join(', '))} | What | Column | A | B |`, '| --- | --- | --- | --- | --- |');
      for (const s of e.samples) {
        const k = md(s.key.map(v => cellText(v, 40)).join(', '));
        if (s.kind === 'changed') for (const d of s.cols) L.push(`| ${k} | differs | ${md(d.col)} | ${md(cellText(d.a))} | ${md(cellText(d.b))} |`);
        else L.push(`| ${k} | ${s.kind} | | | |`);
      }
      L.push('');
    }
    if (sum.noKey.length) L.push(`Not compared row by row, because A and B do not share a primary key (or rowid) for them: ${sum.noKey.map(n => `\`${md(n)}\``).join(', ')}.`, '');
  }
  return L.join('\n') + '\n';
}

// ---------- ER diagram and schema document ----------

/** Plain model for the diagram and the document. */
function schemaModel(db) {
  const s = readSchema(db, { counts: true });
  const tables = [...s.tables.values()].filter(t => t.kind !== 'shadow');
  return { tables, views: [...s.views.values()], triggers: [...s.triggers.values()], indexes: [...s.indexes.values()] };
}

const mmId = (name, used) => {
  let id = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(id)) id = 't_' + id;
  let out = id;
  for (let i = 2; used.has(out); i++) out = `${id}_${i}`;
  used.add(out);
  return out;
};
const mmWord = (s, dflt) => {
  let w = String(s || '').trim().replace(/[^A-Za-z0-9_()[\]-]/g, '_');
  if (!w) return dflt;
  if (!/^[A-Za-z_]/.test(w)) w = '_' + w;
  return w;
};

/** Mermaid erDiagram text: entities with columns (PK, FK, UK) and one line per foreign key. */
function erMermaid(model) {
  const used = new Set();
  const ids = new Map(model.tables.map(t => [t.name, mmId(t.name, used)]));
  const L = ['erDiagram'];
  for (const t of model.tables) {
    const id = ids.get(t.name);
    const head = id === t.name ? id : `${id}["${String(t.name).replace(/"/g, "'")}"]`;
    const fkCols = new Set(t.fks.flatMap(f => f.cols));
    const unique = new Set(t.indexes.filter(i => i.unique && i.cols.length === 1 && i.origin !== 'pk').map(i => i.cols[0]));
    L.push(`  ${head} {`);
    for (const c of t.columns.filter(c => c.hidden !== 1)) {
      const keys = [c.pk ? 'PK' : '', fkCols.has(c.name) ? 'FK' : '', unique.has(c.name) && !c.pk ? 'UK' : ''].filter(Boolean).join(', ');
      const name = mmWord(c.name, 'column');
      const note = name !== c.name ? ` "${String(c.name).replace(/"/g, "'")}"` : '';
      L.push(`    ${mmWord(c.type, 'ANY')} ${name}${keys ? ' ' + keys : ''}${note}`);
    }
    L.push('  }');
  }
  for (const t of model.tables) {
    for (const f of t.fks) {
      if (!ids.has(f.ref)) continue;
      const required = f.cols.every(c => { const col = t.columns.find(x => x.name === c); return col && (col.notnull || (col.pk && t.withoutRowid)); });
      L.push(`  ${ids.get(f.ref)} ${required ? '||' : '|o'}--o{ ${ids.get(t.name)} : "${f.cols.join(', ').replace(/"/g, "'")}"`);
    }
  }
  return L.join('\n') + '\n';
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');

/** SVG ER diagram: referenced tables to the left, tables that point to them to the right, lines per foreign key. */
function erSvg(model, opts = {}) {
  const ROW = 18, HEAD = 26, PAD = 10, GAP_X = 90, GAP_Y = 28, MAX_COLS = 40, CH = 7.2;
  const title = opts.title || 'Database';
  const byName = new Map(model.tables.map(t => [t.name, t]));
  // Rank: 0 for tables that point to no other table, else 1 + the highest rank they point to (cycles cut).
  const rank = new Map();
  const visit = (t, stack) => {
    if (rank.has(t.name)) return rank.get(t.name);
    if (stack.has(t.name)) return 0;
    stack.add(t.name);
    let r = 0;
    for (const f of t.fks) if (f.ref !== t.name && byName.has(f.ref)) r = Math.max(r, visit(byName.get(f.ref), stack) + 1);
    stack.delete(t.name);
    rank.set(t.name, r);
    return r;
  };
  for (const t of model.tables) visit(t, new Set());
  const boxes = new Map();
  for (const t of model.tables) {
    const cols = t.columns.filter(c => c.hidden !== 1);
    const shown = cols.slice(0, MAX_COLS);
    const lines = shown.map(c => ({ name: c.name, type: c.type || '', key: c.pk ? 'PK' : t.fks.some(f => f.cols.includes(c.name)) ? 'FK' : '' }));
    if (cols.length > shown.length) lines.push({ name: `… ${cols.length - shown.length} more`, type: '', key: '' });
    const label = t.kind === 'virtual' ? `${t.name} (virtual)` : t.name;
    const textW = Math.max(label.length + (t.rows !== null ? String(fmt(t.rows)).length + 8 : 0), ...lines.map(l => l.name.length + l.type.length + 6));
    const w = Math.max(160, Math.min(420, Math.round(textW * CH + PAD * 2)));
    boxes.set(t.name, { t, lines, w, h: HEAD + lines.length * ROW + 6, x: 0, y: 0, label });
  }
  // Columns by rank; a long rank wraps into several columns.
  const ranks = [...new Set(rank.values())].sort((a, b) => a - b);
  const heights = [...boxes.values()].map(b => b.h + GAP_Y);
  const total = heights.reduce((a, b) => a + b, 0);
  const limit = Math.max(Math.max(0, ...heights), Math.round(Math.sqrt(total * 900)));
  let x = 30;
  const top = 64;
  const posY = new Map();
  for (const r of ranks) {
    const members = model.tables.filter(t => rank.get(t.name) === r);
    // Order by the average position of the tables they point to, so lines cross less.
    const bary = t => { const ys = t.fks.map(f => posY.get(f.ref)).filter(v => v !== undefined); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity; };
    members.sort((a, b) => (bary(a) - bary(b)) || (a.name < b.name ? -1 : 1));
    let y = top;
    let colW = 0;
    for (const t of members) {
      const b = boxes.get(t.name);
      if (y > top && y + b.h > top + limit) { x += colW + GAP_X; y = top; colW = 0; }
      b.x = x; b.y = y;
      posY.set(t.name, y + b.h / 2);
      y += b.h + GAP_Y;
      colW = Math.max(colW, b.w);
    }
    x += colW + GAP_X;
  }
  const W = Math.max(400, x - GAP_X + 30);
  const H = Math.max(160, ...[...boxes.values()].map(b => b.y + b.h + 30));
  const rowY = (b, col) => {
    const i = b.lines.findIndex(l => l.name === col);
    return i < 0 ? b.y + HEAD / 2 : b.y + HEAD + i * ROW + ROW / 2 + 2;
  };
  const S = [];
  S.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="12">`);
  S.push(`<title>${xml(title)} ER diagram</title>`);
  S.push('<defs><marker id="one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M2 1 V11 M6 1 V11" stroke="#475569" stroke-width="1.4" fill="none"/></marker>'
    + '<marker id="many" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M11 1 L1 6 L11 11 M1 6 H11" stroke="#475569" stroke-width="1.4" fill="none"/></marker></defs>');
  S.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  S.push(`<text x="30" y="36" font-size="18" font-weight="600" fill="#0f172a">${xml(title)}</text>`);
  S.push(`<text x="30" y="54" fill="#64748b">${plural(model.tables.length, 'table')}, ${plural(model.tables.reduce((n, t) => n + t.fks.length, 0), 'foreign key')}. Written by SQLite Editor (Zovo Pro).</text>`);
  // Lines first, boxes on top.
  for (const t of model.tables) {
    const child = boxes.get(t.name);
    for (const f of t.fks) {
      const parent = boxes.get(f.ref);
      if (!parent) continue;
      const y1 = rowY(child, f.cols[0]);
      const pkCol = f.refCols[0] || (parent.t.pk[0] || '');
      const y2 = rowY(parent, pkCol);
      let d;
      if (parent === child) {
        const xr = child.x + child.w;
        d = `M${xr} ${y1} C${xr + 50} ${y1}, ${xr + 50} ${y2}, ${xr} ${y2}`;
      } else if (parent.x + parent.w < child.x) {
        const x1 = child.x, x2 = parent.x + parent.w, mx = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      } else if (child.x + child.w < parent.x) {
        const x1 = child.x + child.w, x2 = parent.x, mx = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      } else {
        const x1 = child.x + child.w, x2 = parent.x + parent.w, xr = Math.max(x1, x2) + 40;
        d = `M${x1} ${y1} C${xr} ${y1}, ${xr} ${y2}, ${x2} ${y2}`;
      }
      S.push(`<path d="${d}" fill="none" stroke="#64748b" stroke-width="1.3" marker-start="url(#many)" marker-end="url(#one)"><title>${xml(`${t.name}(${f.cols.join(', ')}) -> ${f.ref}(${f.refCols.map(c => c || 'PK').join(', ')})`)}</title></path>`);
    }
  }
  for (const b of boxes.values()) {
    S.push(`<g><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="#f8fafc" stroke="#94a3b8"/>`);
    S.push(`<path d="M${b.x} ${b.y + 6} a6 6 0 0 1 6 -6 h${b.w - 12} a6 6 0 0 1 6 6 v${HEAD - 6} h-${b.w} z" fill="${b.t.kind === 'virtual' ? '#64748b' : '#1e3a5f'}"/>`);
    S.push(`<text x="${b.x + PAD}" y="${b.y + 17}" fill="#ffffff" font-weight="600">${xml(b.label)}</text>`);
    if (b.t.rows !== null) S.push(`<text x="${b.x + b.w - PAD}" y="${b.y + 17}" fill="#cbd5e1" text-anchor="end">${xml(fmt(b.t.rows))} rows</text>`);
    b.lines.forEach((l, i) => {
      const y = b.y + HEAD + i * ROW + 14;
      if (l.key) S.push(`<text x="${b.x + PAD}" y="${y}" fill="${l.key === 'PK' ? '#b45309' : '#2563eb'}" font-size="10" font-weight="700">${l.key}</text>`);
      S.push(`<text x="${b.x + PAD + 22}" y="${y}" fill="#0f172a">${xml(l.name)}</text>`);
      if (l.type) S.push(`<text x="${b.x + b.w - PAD}" y="${y}" fill="#64748b" text-anchor="end">${xml(l.type)}</text>`);
    });
    S.push('</g>');
  }
  S.push('</svg>');
  return S.join('\n') + '\n';
}

/** Markdown schema document: summary, the Mermaid diagram, then every table with columns, keys, indexes, triggers. */
function schemaMarkdown(model, opts = {}) {
  const title = opts.title || 'Database';
  const L = [`# ${md(title)}: database schema`, ''];
  const fkCount = model.tables.reduce((n, t) => n + t.fks.length, 0);
  L.push(`${plural(model.tables.length, 'table')}, ${plural(model.views.length, 'view')}, ${plural(model.indexes.filter(i => i.sql).length, 'index', 'indexes')}, ${plural(model.triggers.length, 'trigger')}, ${plural(fkCount, 'foreign key')}.`);
  L.push(`Written ${opts.now || new Date().toISOString()} by SQLite Editor (Zovo Pro) from ${md(opts.path || title)}.`, '');
  if (opts.svgName) L.push(`Diagram: [${md(opts.svgName)}](${encodeURI(opts.svgName)})${opts.mmdName ? `, Mermaid source: [${md(opts.mmdName)}](${encodeURI(opts.mmdName)})` : ''}.`, '');
  L.push('## Tables', '', '| Table | Rows | Columns | Primary key | References |', '| --- | ---: | ---: | --- | --- |');
  for (const t of model.tables) {
    const refs = [...new Set(t.fks.map(f => f.ref))].map(r => `[${md(r)}](#${anchor(r)})`).join(', ');
    L.push(`| [${md(t.name)}](#${anchor(t.name)})${t.kind === 'virtual' ? ' (virtual)' : ''} | ${t.rows === null ? '-' : fmt(t.rows)} | ${t.columns.filter(c => c.hidden !== 1).length} | ${md(t.pk.join(', ') || (t.withoutRowid ? '' : 'rowid'))} | ${refs} |`);
  }
  L.push('');
  if (model.tables.length <= (opts.mermaidMax || 60)) L.push('## Diagram', '', '```mermaid', erMermaid(model).trimEnd(), '```', '');
  for (const t of model.tables) {
    L.push(`## ${md(t.name)}`, '');
    const refsIn = model.tables.filter(o => o.fks.some(f => f.ref === t.name)).map(o => `[${md(o.name)}](#${anchor(o.name)})`);
    L.push(`${t.rows === null ? '' : fmt(t.rows) + ' rows. '}${t.withoutRowid ? 'WITHOUT ROWID. ' : ''}${refsIn.length ? 'Referenced by ' + refsIn.join(', ') + '.' : ''}`.trim() || '-', '');
    L.push('| Column | Type | Key | Not null | Default | References |', '| --- | --- | --- | --- | --- | --- |');
    for (const c of t.columns.filter(c => c.hidden !== 1)) {
      const f = t.fks.find(x => x.cols.includes(c.name));
      const ref = f ? `${md(f.ref)}(${md(f.refCols[f.cols.indexOf(c.name)] || 'PK')})${f.onDelete && f.onDelete !== 'NO ACTION' ? ' on delete ' + md(f.onDelete.toLowerCase()) : ''}` : '';
      L.push(`| ${md(c.name)} | ${md(c.type)} | ${c.pk ? 'PK' : f ? 'FK' : ''} | ${c.notnull || c.pk ? 'yes' : ''} | ${c.dflt === null || c.dflt === undefined ? '' : md(c.dflt)} | ${ref} |`);
    }
    L.push('');
    const ix = t.indexes;
    if (ix.length) {
      L.push('Indexes:', '');
      for (const i of ix) L.push(`- \`${md(i.name)}\`${i.unique ? ' unique' : ''} (${md(i.cols.join(', '))})${i.origin === 'pk' ? ', primary key' : i.origin === 'u' ? ', UNIQUE constraint' : ''}${i.partial ? ', partial' : ''}`);
      L.push('');
    }
    if (t.triggers.length) L.push(`Triggers: ${t.triggers.map(n => `\`${md(n)}\``).join(', ')}`, '');
    L.push('<details><summary>CREATE statement</summary>', '', '```sql', t.sql.trim(), '```', '', '</details>', '');
  }
  if (model.views.length) {
    L.push('## Views', '');
    for (const v of model.views) L.push(`### ${md(v.name)}`, '', '```sql', v.sql.trim(), '```', '');
  }
  if (model.triggers.length) {
    L.push('## Triggers', '');
    for (const v of model.triggers) L.push(`### ${md(v.name)} (on ${md(v.tbl)})`, '', '```sql', v.sql.trim(), '```', '');
  }
  return L.join('\n') + '\n';
}

function anchor(name) {
  return String(name).toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
}

// ---------- export every table ----------

const XLSX_MAX_ROWS = 1048575; // data rows below the header row
const XLSX_MAX_TEXT = 32767;

function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetNames(names) {
  const used = new Set();
  return names.map(n => {
    let base = String(n).replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31) || 'table';
    let out = base;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = base.slice(0, 31 - String(i).length - 1) + '~' + i;
    used.add(out.toLowerCase());
    return out;
  });
}

/** Tables that hold rows of their own (no views, virtual or shadow tables). */
function exportableTables(db) {
  return [...readSchema(db).tables.values()].filter(t => t.kind === 'table');
}

/**
 * Parts of an .xlsx workbook with one sheet per table (bold, frozen header row). Returns { files, sheets }, where
 * files go to zipFiles and sheets lists { table, sheet, rows, truncated }.
 */
function workbookParts(db, opts = {}) {
  const maxRows = Math.min(opts.maxRows || XLSX_MAX_ROWS, XLSX_MAX_ROWS);
  const tables = exportableTables(db);
  const names = sheetNames(tables.map(t => t.name));
  const files = [];
  const sheets = [];
  tables.forEach((t, si) => {
    const cols = t.columns.filter(c => c.hidden !== 1).map(c => c.name);
    const chunks = [];
    let buf = '';
    const flush = () => { if (buf) { chunks.push(Buffer.from(buf, 'utf8')); buf = ''; } };
    buf += '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    buf += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>';
    buf += '<row r="1">' + cols.map((c, i) => `<c r="${colLetter(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(c)}</t></is></c>`).join('') + '</row>';
    const letters = cols.map((_, i) => colLetter(i));
    let n = 0;
    let truncated = false;
    let cut = 0;
    eachRow(db, `SELECT ${cols.map(q).join(', ')} FROM ${q(t.name)}`, r => {
      if (n >= maxRows) { truncated = true; return false; }
      n++;
      const rn = n + 1;
      let row = `<row r="${rn}">`;
      for (let i = 0; i < r.length; i++) {
        const v = r[i];
        if (v === null || v === undefined) continue;
        const ref = letters[i] + rn;
        if (typeof v === 'number' && Number.isFinite(v)) { row += `<c r="${ref}"><v>${v}</v></c>`; continue; }
        let s = v instanceof Uint8Array ? `(BLOB ${v.length} bytes)` : String(v);
        if (s.length > XLSX_MAX_TEXT) { s = s.slice(0, XLSX_MAX_TEXT); cut++; }
        row += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
      }
      buf += row + '</row>';
      if (buf.length > 1 << 20) flush();
      return true;
    });
    buf += '</sheetData></worksheet>';
    flush();
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: Buffer.concat(chunks) });
    sheets.push({ table: t.name, sheet: names[si], rows: n, truncated, cutCells: cut });
  });
  if (!tables.length) {
    files.push({ name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>' });
    names.push('empty');
  }
  const count = Math.max(1, tables.length);
  const sheetList = Array.from({ length: count }, (_, i) => i);
  files.unshift(
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheetList.map(i => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + sheetList.map(i => `<sheet name="${xml(names[i])}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheetList.map(i => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
  );
  return { files, sheets };
}

/** File name for a table's CSV: letters, digits, dot, dash and underscore; unique within the folder. */
function csvFileNames(names) {
  const used = new Set();
  return names.map(n => {
    const base = String(n).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '_').slice(0, 120) || 'table';
    let out = base;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = `${base}_${i}`;
    used.add(out.toLowerCase());
    return out + '.csv';
  });
}

/** Writes one CSV per table through write(fileName, text chunk). Returns [{ table, file, rows, truncated }]. */
function csvTables(db, write, opts = {}) {
  const maxRows = opts.maxRows || 1000000;
  const tables = exportableTables(db);
  const files = csvFileNames(tables.map(t => t.name));
  return tables.map((t, i) => {
    const cols = t.columns.filter(c => c.hidden !== 1).map(c => c.name);
    let buf = cols.map(c => U.csvField(c, ',')).join(',') + '\r\n';
    let n = 0;
    let truncated = false;
    eachRow(db, `SELECT ${cols.map(q).join(', ')} FROM ${q(t.name)}`, r => {
      if (n >= maxRows) { truncated = true; return false; }
      n++;
      buf += r.map(v => U.csvField(v, ',')).join(',') + '\r\n';
      if (buf.length > 1 << 20) { write(files[i], buf); buf = ''; }
      return true;
    });
    write(files[i], buf);
    return { table: t.name, file: files[i], rows: n, truncated };
  });
}

module.exports = {
  readSchema, tableDiff, rowKey, compareDatabases, schemaModel, erMermaid, erSvg, schemaMarkdown,
  workbookParts, csvTables, sheetNames, csvFileNames, colLetter, B_SCHEMA,
};
