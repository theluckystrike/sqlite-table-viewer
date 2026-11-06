'use strict';
// Checks every message from the webview before the host acts on it. Anything unexpected is dropped.

const FORMATS = new Set(['csv', 'tsv', 'json', 'insert']);
const EXPORTS = new Set(['csv', 'json']);
const MAX_SQL = 100000;
const MAX_NAME = 1000;
const MAX_FILTER = 1000;

const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': case 'openSettings': case 'objects':
      return { type: m.type };
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
    default:
      return null;
  }
}

module.exports = { validateWebviewMessage, FORMATS, EXPORTS };
