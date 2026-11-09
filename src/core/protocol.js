'use strict';
// Checks every message from the webview before the host acts on it. Anything unexpected is dropped.

const FORMATS = new Set(['csv', 'tsv', 'json', 'insert']);
const EXPORTS = new Set(['csv', 'json', 'sql']);
const VALUE_TYPES = new Set(['text', 'int', 'real', 'null', 'hex', 'auto']);
const ENCODINGS = new Set(['utf-8', 'utf-16le', 'windows-1252']);
const DELIMS = new Set([',', ';', '\t', '|']);
const TRANSFORMS = new Set(['none', 'trim', 'lower', 'upper', 'empty-null', 'number']);
const SCHEMA_ACTIONS = new Set(['addColumn', 'renameColumn', 'dropColumn', 'renameTable']);
const MAX_VALUE = 16 * 1024 * 1024;
const MAX_SQL = 100000;
const MAX_NAME = 1000;
const MAX_FILTER = 1000;

const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': case 'openSettings': case 'objects': case 'reload':
      return { type: m.type };
    case 'setAutoReload':
      return typeof m.on === 'boolean' ? { type: 'setAutoReload', on: m.on } : null;
    case 'openTable': case 'count': case 'schema':
      return isStr(m.name, MAX_NAME) && m.name ? { type: m.type, name: m.name } : null;
    case 'runSql':
      return isStr(m.sql, MAX_SQL) && m.sql.trim() ? { type: 'runSql', sql: m.sql } : null;
    case 'getRows':
      return isInt(m.reqId) && isInt(m.start) && isInt(m.count, 1, 1000) ? { type: 'getRows', reqId: m.reqId, start: m.start, count: m.count } : null;
    case 'sort':
      if (m.col === null) return { type: 'sort', col: null, dir: null };
      return isInt(m.col, 0, 100000) && (m.dir === 'asc' || m.dir === 'desc') ? { type: 'sort', col: m.col, dir: m.dir } : null;
    case 'filter': {
      if (m.global !== undefined && !isStr(m.global, MAX_FILTER)) return null;
      const columns = {};
      if (m.columns !== undefined) {
        if (!m.columns || typeof m.columns !== 'object' || Array.isArray(m.columns)) return null;
        const entries = Object.entries(m.columns);
        if (entries.length > 2000) return null;
        for (const [k, v] of entries) {
          if (!/^\d{1,6}$/.test(k) || !isStr(v, MAX_FILTER)) return null;
          columns[k] = v;
        }
      }
      return { type: 'filter', global: m.global || '', columns };
    }
    case 'cell':
      return isInt(m.row) && isInt(m.col, 0, 100000) ? { type: 'cell', row: m.row, col: m.col } : null;
    case 'copy': {
      const s = m.sel;
      if (!FORMATS.has(m.format) || !s || typeof s !== 'object') return null;
      if (![s.r0, s.r1, s.c0, s.c1].every(v => isInt(v)) || s.r1 < s.r0 || s.c1 < s.c0) return null;
      return { type: 'copy', format: m.format, sel: { r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1, header: s.header !== false } };
    }
    case 'export':
      return m.format === undefined || EXPORTS.has(m.format) ? { type: 'export', format: m.format } : null;
    // ---------- editing ----------
    case 'enableEditing': case 'disableEditing': case 'undo': case 'discard': case 'save': case 'importCsv':
    case 'importCancel': case 'pendingList': case 'checkpoint': case 'findReplace':
      return { type: m.type };
    case 'editCell': {
      const v = m.value;
      if (!isInt(m.row) || !isInt(m.col, 0, 100000) || !isInt(m.version) || !v || typeof v !== 'object') return null;
      if (!VALUE_TYPES.has(v.t) || (v.v !== undefined && !isStr(v.v, MAX_VALUE))) return null;
      return { type: 'editCell', row: m.row, col: m.col, version: m.version, value: { t: v.t, v: v.v === undefined ? '' : v.v } };
    }
    case 'insertRow':
      return isInt(m.version) ? { type: 'insertRow', version: m.version } : null;
    case 'duplicateRows': case 'deleteRows':
      return isInt(m.r0) && isInt(m.r1) && m.r1 >= m.r0 && isInt(m.version) ? { type: m.type, r0: m.r0, r1: m.r1, version: m.version } : null;
    case 'blobFromFile':
      return isInt(m.row) && isInt(m.col, 0, 100000) && isInt(m.version) ? { type: 'blobFromFile', row: m.row, col: m.col, version: m.version } : null;
    case 'blobToFile':
      return isInt(m.row) && isInt(m.col, 0, 100000) ? { type: 'blobToFile', row: m.row, col: m.col } : null;
    case 'schemaAction':
      return SCHEMA_ACTIONS.has(m.action) ? { type: 'schemaAction', action: m.action, col: isInt(m.col, 0, 100000) ? m.col : null } : null;
    case 'importPreview': {
      const o = m.options || {};
      if (o.encoding !== undefined && !ENCODINGS.has(o.encoding)) return null;
      if (o.delimiter !== undefined && !DELIMS.has(o.delimiter)) return null;
      if (o.header !== undefined && typeof o.header !== 'boolean') return null;
      return { type: 'importPreview', options: { encoding: o.encoding, delimiter: o.delimiter, header: o.header } };
    }
    case 'importRun': {
      const o = m.options;
      if (!o || typeof o !== 'object') return null;
      if (!ENCODINGS.has(o.encoding) || !DELIMS.has(o.delimiter) || typeof o.header !== 'boolean') return null;
      if (o.mode !== 'new' && o.mode !== 'existing') return null;
      if (!isStr(o.table, MAX_NAME) || !o.table.trim()) return null;
      if (!Array.isArray(o.columns) || !o.columns.length || o.columns.length > 2000) return null;
      const columns = [];
      for (const c of o.columns) {
        if (!c || !isInt(c.src, 0, 100000) || !isStr(c.name, MAX_NAME) || !c.name.trim() || !isStr(c.type || '', 60)) return null;
        if (c.transform !== undefined && !TRANSFORMS.has(c.transform)) return null;
        columns.push({ src: c.src, name: c.name.trim(), type: c.type || '', transform: c.transform || 'none' });
      }
      return { type: 'importRun', options: { encoding: o.encoding, delimiter: o.delimiter, header: o.header, mode: o.mode, table: o.table.trim(), columns } };
    }
    default:
      return null;
  }
}

module.exports = { validateWebviewMessage, FORMATS, EXPORTS, MAX_VALUE };
