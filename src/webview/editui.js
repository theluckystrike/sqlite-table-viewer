'use strict';
// Pure helpers for the editing UI (no DOM), so they are unit tested in Node.

const TYPE_CHOICES = [
  ['auto', 'Auto (by column type)'],
  ['text', 'TEXT'],
  ['int', 'INTEGER'],
  ['real', 'REAL'],
  ['null', 'NULL'],
  ['hex', 'BLOB (hex)'],
];
const DELIMS = [[',', 'comma ,'], [';', 'semicolon ;'], ['\t', 'tab'], ['|', 'pipe |']];
const ENCODINGS = [['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252 (Western)'], ['utf-16le', 'UTF-16 LE']];
const TRANSFORMS = [['none', 'none'], ['trim', 'trim spaces'], ['lower', 'lower case'], ['upper', 'upper case'], ['empty-null', 'empty to NULL'], ['number', 'clean number (1,234 to 1234)']];

/** 'inline' when a grid cell value can be edited in place, 'panel' when it needs the cell panel. */
function inlineKind(v) {
  if (v === undefined) return 'none';
  if (v === null || typeof v === 'number' || typeof v === 'string') return typeof v === 'string' && /[\r\n]/.test(v) ? 'panel' : 'inline';
  if (v && typeof v === 'object') {
    if (typeof v.i === 'string') return 'inline';
    return 'panel'; // cut text or a BLOB
  }
  return 'panel';
}

/** Text to start the inline editor with. */
function editText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof v.i === 'string') return v.i;
  return String(v);
}

/** Did the inline edit change the value? NULL edited to '' counts as no change. */
function changed(before, text) {
  if (before === null || before === undefined) return text !== '';
  return editText(before) !== text;
}

/** Default type in the cell panel editor for a described value (sqlutil.describeCell). */
function defaultType(v) {
  if (!v) return 'auto';
  if (v.kind === 'blob') return 'hex';
  if (v.kind === 'integer') return 'int';
  if (v.kind === 'real') return 'real';
  if (v.kind === 'text') return 'text';
  return 'auto';
}

function panelText(v) {
  if (!v || v.kind === 'null' || v.kind === 'blob') return '';
  return v.text || '';
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function percent(p) {
  if (!p || !p.size) return 0;
  return Math.max(0, Math.min(100, Math.round((p.bytes / p.size) * 100)));
}

function progressText(p) {
  if (!p) return '';
  const rows = Number(p.rows || 0).toLocaleString('en-US');
  return p.size ? `${rows} rows · ${bytes(p.bytes || 0)} of ${bytes(p.size)} (${percent(p)}%)` : `${rows} rows`;
}

function baseName(p) { return String(p || '').replace(/^.*[\\/]/, ''); }

/** The import form for a preview. keep: the form from the previous preview of the same file. */
function importForm(p, keep) {
  const mode = keep ? keep.mode : 'new';
  const form = {
    mode,
    table: keep ? keep.table : p.table,
    targetColumns: keep ? keep.targetColumns : null,
    columns: p.names.map((n, i) => {
      const old = keep && keep.columns[i];
      return { include: old ? old.include : true, name: old && old.name ? old.name : n, type: p.types[i], transform: old ? old.transform : 'none', target: old ? old.target : '' };
    }),
  };
  if (form.targetColumns) autoMap(p, form);
  return form;
}

/** Existing-table mode: map each CSV column to the table column with the same name (any case). */
function autoMap(p, form) {
  const cols = form.targetColumns || [];
  const byLower = new Map(cols.map(c => [c.toLowerCase(), c]));
  p.names.forEach((n, i) => {
    const m = form.columns[i];
    if (m.target && cols.includes(m.target)) return;
    m.target = byLower.get(n.trim().toLowerCase()) || (cols.length === p.names.length ? cols[i] : '');
  });
}

/** Options for an importRun message, or { ok: false, message }. */
function importOptions(p, form) {
  const table = String(form.table || '').trim();
  if (!table) return { ok: false, message: 'Type a table name.' };
  const columns = [];
  form.columns.forEach((m, i) => {
    if (!m.include) return;
    const name = form.mode === 'new' ? String(m.name || '').trim() : m.target;
    if (!name) return;
    columns.push({ src: i, name, type: form.mode === 'new' ? m.type : '', transform: m.transform || 'none' });
  });
  if (!columns.length) return { ok: false, message: form.mode === 'new' ? 'Pick at least one column.' : 'Map at least one CSV column to a table column.' };
  const seen = new Set();
  for (const c of columns) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return { ok: false, message: `Two CSV columns go into ${c.name}.` };
    seen.add(k);
  }
  return { ok: true, options: { encoding: p.encoding, delimiter: p.delimiter, header: !!p.header, mode: form.mode, table, columns } };
}

module.exports = { TYPE_CHOICES, DELIMS, ENCODINGS, TRANSFORMS, inlineKind, editText, changed, defaultType, panelText, bytes, percent, progressText, baseName, importForm, autoMap, importOptions };
