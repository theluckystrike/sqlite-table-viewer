'use strict';
// Pure helpers: file sniffing, read-only SQL checks, filter clauses with bound parameters,
// cell encoding and export formats. No sql.js and no vscode here, so all of it is unit tested.

const HEADER = 'SQLite format 3\u0000';
const IMAGE_KINDS = new Set(['png', 'jpeg', 'gif', 'webp']);

/** 'sqlite' when the first 16 bytes are the SQLite header, 'empty' for a 0-byte file, else 'other'. */
function sniff(bytes) {
  if (!bytes || bytes.length === 0) return 'empty';
  if (bytes.length < 16) return 'other';
  for (let i = 0; i < 16; i++) if (bytes[i] !== HEADER.charCodeAt(i)) return 'other';
  return 'sqlite';
}

/** A clear message for a file that does not start with the SQLite header. */
function notSqliteMessage(bytes, size) {
  const n = Math.min(bytes.length, 4096);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) printable++;
  }
  if (n > 0 && printable / n > 0.95) return 'This is not a SQLite database. The file starts with plain text, not with the "SQLite format 3" header.';
  if (size >= 1024 && size % 512 === 0) {
    return 'This file cannot be read. It does not start with the "SQLite format 3" header. It is probably an encrypted database (SQLCipher or SEE) or another binary format. SQLite Editor does not open encrypted databases.';
  }
  return 'This is not a SQLite database. The file does not start with the "SQLite format 3" header.';
}

/** Turn a sql.js error into a message a person can act on. */
function friendlyOpenError(e) {
  const m = String((e && e.message) || e);
  if (/not a database|file is encrypted/i.test(m)) return 'This file has a SQLite header but SQLite cannot read it. It may be encrypted or damaged.';
  if (/malformed|corrupt/i.test(m)) return 'This database is damaged (SQLite says: "database disk image is malformed"). Some or all tables cannot be read.';
  if (/out of memory|memory access|Cannot enlarge memory/i.test(m)) return 'The database is too large to load into memory. Lower sqliteTableViewer.maxFileSizeMB or open a smaller copy.';
  return m;
}

/** Copy of the file bytes that SQLite can open from memory: a WAL-mode header is switched to rollback mode. */
function prepareBytes(bytes) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  // Bytes 18 and 19 are the read and write format versions. 2 means WAL, which needs shared memory
  // that an in-memory database lacks. Only this copy changes; the file on disk is never written.
  if (copy.length >= 100 && (copy[18] === 2 || copy[19] === 2)) { copy[18] = 1; copy[19] = 1; }
  return copy;
}

/** "name" with inner quotes doubled. */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function quoteValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? '9e999' : v < 0 ? '-9e999' : 'NULL';
  if (v instanceof Uint8Array) return "X'" + toHex(v) + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

// ---------- read-only SQL ----------

// PRAGMAs that only read. Assignments (PRAGMA x = y) are never allowed.
const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list',
  'foreign_key_check', 'integrity_check', 'quick_check', 'page_count', 'page_size', 'freelist_count',
  'user_version', 'application_id', 'schema_version', 'encoding', 'compile_options', 'database_list',
  'collation_list', 'function_list', 'module_list', 'pragma_list', 'journal_mode', 'auto_vacuum',
  'data_version', 'max_page_count', 'foreign_keys', 'recursive_triggers', 'cache_size',
]);
const WRITE_WORDS = /\b(insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/** SQL with comments removed and string, identifier and blob literals blanked out, for keyword checks. */
function maskSql(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '-' && d === '-') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= s.length) break;
        if (s[j] === close) { if (close !== ']' && s[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      out += c === "'" ? "''" : '""';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove trailing semicolons, whitespace and line comments so the text can be wrapped in a subquery. */
function trimStatement(sql) {
  return String(sql).replace(/(\s|;)+$/g, '');
}

/**
 * Decide whether a statement may run. Returns { ok, mode, message }.
 * mode 'select' (SELECT, WITH, VALUES): wrapped as a subquery so paging, sort and filters work.
 * mode 'list' (PRAGMA, EXPLAIN): run once and the rows are listed.
 * The database also runs with PRAGMA query_only = ON, so SQLite itself refuses writes.
 */
function checkReadOnly(sql) {
  const masked = maskSql(sql);
  const parts = masked.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, message: 'Type a SELECT statement.' };
  if (parts.length > 1) return { ok: false, message: 'Run one statement at a time.' };
  const body = parts[0];
  const first = (body.match(/^[a-z]+/i) || [''])[0].toLowerCase();
  if (first === 'select' || first === 'values' || first === 'with') {
    if (WRITE_WORDS.test(body)) return { ok: false, message: 'Only read-only statements run here. This database is opened read-only.' };
    return { ok: true, mode: 'select' };
  }
  if (first === 'explain') {
    if (WRITE_WORDS.test(body.replace(/^explain\s+(query\s+plan\s+)?/i, ''))) return { ok: false, message: 'EXPLAIN works for read-only statements only.' };
    return { ok: true, mode: 'list' };
  }
  if (first === 'pragma') {
    const m = body.match(/^pragma\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?([a-z_][a-z0-9_]*)\s*(\(|=|$)/i);
    if (!m) return { ok: false, message: 'This PRAGMA form is not supported.' };
    if (m[2] === '=') return { ok: false, message: 'PRAGMA assignments change the database. Only reading PRAGMAs run here.' };
    if (!READ_PRAGMAS.has(m[1].toLowerCase())) return { ok: false, message: `PRAGMA ${m[1]} is not on the read-only list.` };
    if (m[2] === '(' && !/^(table_|index_|foreign_key_|integrity_check|quick_check)/i.test(m[1])) {
      return { ok: false, message: `PRAGMA ${m[1]}(...) sets a value. Only reading PRAGMAs run here.` };
    }
    return { ok: true, mode: 'list' };
  }
  return { ok: false, message: 'Only SELECT, WITH, VALUES, EXPLAIN and reading PRAGMA statements run here. This database is opened read-only.' };
}

// ---------- filters ----------

function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, m => '\\' + m);
}

function numOrText(v) {
  const t = v.trim();
  return /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(t) ? Number(t) : t;
}

/**
 * WHERE fragment for one column filter. Every value is a bound parameter; only the quoted
 * column name goes into the SQL text.
 * Syntax: text (contains), =x, !=x, !x (does not contain), >x, >=x, <x, <=x, a..b, empty, !empty.
 */
function filterClause(colExpr, text) {
  const t = String(text).trim();
  if (!t) return null;
  if (/^empty$/i.test(t)) return { sql: `(${colExpr} IS NULL OR ${colExpr} = '')`, params: [] };
  if (/^!empty$/i.test(t)) return { sql: `(${colExpr} IS NOT NULL AND ${colExpr} <> '')`, params: [] };
  const range = t.match(/^(-?[\d.]+(?:e-?\d+)?)\s*\.\.\s*(-?[\d.]+(?:e-?\d+)?)$/i);
  if (range && !Number.isNaN(Number(range[1])) && !Number.isNaN(Number(range[2]))) {
    return { sql: `${colExpr} BETWEEN ? AND ?`, params: [Number(range[1]), Number(range[2])] };
  }
  const op = t.match(/^(>=|<=|!=|<>|>|<|=)\s*(.*)$/s);
  if (op) {
    const sym = op[1] === '<>' ? '!=' : op[1];
    const v = numOrText(op[2]);
    if (sym === '!=') return { sql: `(${colExpr} IS NULL OR ${colExpr} != ?)`, params: [v] };
    return { sql: `${colExpr} ${sym} ?`, params: [v] };
  }
  if (t.startsWith('!')) {
    return { sql: `(${colExpr} IS NULL OR CAST(${colExpr} AS TEXT) NOT LIKE ? ESCAPE '\\')`, params: ['%' + likeEscape(t.slice(1)) + '%'] };
  }
  return { sql: `CAST(${colExpr} AS TEXT) LIKE ? ESCAPE '\\'`, params: ['%' + likeEscape(t) + '%'] };
}

/** Full WHERE clause for the column filters and the search box. columns: names in view order. */
function buildWhere(columns, filters) {
  const parts = [];
  const params = [];
  const f = filters || {};
  const cols = f.columns || {};
  for (const [k, v] of Object.entries(cols)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= columns.length) continue;
    const c = filterClause(quoteIdent(columns[i]), v);
    if (c) { parts.push(c.sql); params.push(...c.params); }
  }
  const g = typeof f.global === 'string' ? f.global.trim() : '';
  if (g && columns.length) {
    const like = '%' + likeEscape(g) + '%';
    parts.push('(' + columns.map(c => `CAST(${quoteIdent(c)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (let i = 0; i < columns.length; i++) params.push(like);
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

// ---------- types and cells ----------

/** Column class from a declared type, by SQLite's affinity rules. */
function affinity(declared) {
  const t = String(declared || '').toUpperCase();
  if (t.includes('INT')) return 'int';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'string';
  if (t.includes('BLOB')) return 'blob';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'float';
  if (t.includes('JSON')) return 'json';
  if (t === '') return 'any';
  if (t.includes('DATE') || t.includes('TIME')) return 'date';
  if (t.includes('BOOL')) return 'bool';
  return 'decimal';
}

function blobKind(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 8 && b[0] === 0x47 && b[1] === 0x50 && (b[2] === 0 || b[2] === 1)) return 'gpkg-geometry';
  if (b.length >= 16 && b.length % 4 === 0 && vectorStats(b, 4)) return 'float32';
  return 'binary';
}

const GRID_TEXT = 1000;

/** Value for a grid cell. Long text is cut, BLOBs become a small descriptor. Safe for postMessage. */
function encodeCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : { i: v.toString() };
  if (typeof v === 'number') return v;
  if (v instanceof Uint8Array) return { b: v.length, k: blobKind(v) };
  const s = String(v);
  return s.length > GRID_TEXT ? { t: s.slice(0, GRID_TEXT), n: s.length } : s;
}

/** Decode a BLOB as little-endian float32 (width 4) or float64 (width 8). Null when it does not look like a vector. */
function vectorStats(bytes, width, keep = 0) {
  if (!bytes.length || bytes.length % width) return null;
  const dim = bytes.length / width;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let min = Infinity, max = -Infinity, sum = 0, sq = 0, zeros = 0;
  const head = [];
  for (let i = 0; i < dim; i++) {
    const x = width === 4 ? dv.getFloat32(i * 4, true) : dv.getFloat64(i * 8, true);
    if (!Number.isFinite(x) || Math.abs(x) > 1e6 || (x !== 0 && Math.abs(x) < 1e-30)) return null;
    if (x === 0) zeros++;
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
    sq += x * x;
    if (head.length < keep) head.push(x);
  }
  if (zeros === dim && dim > 1) return null;
  return { width, dim, min, max, mean: sum / dim, norm: Math.sqrt(sq), head };
}

/** Classic hex dump: offset, 16 bytes, ASCII. */
function hexDump(bytes, limit = 4096) {
  const n = Math.min(bytes.length, limit);
  const lines = [];
  for (let off = 0; off < n; off += 16) {
    let hex = '', asc = '';
    for (let i = 0; i < 16; i++) {
      const p = off + i;
      if (p < n) {
        hex += (bytes[p] < 16 ? '0' : '') + bytes[p].toString(16) + (i === 7 ? '  ' : ' ');
        asc += bytes[p] >= 32 && bytes[p] < 127 ? String.fromCharCode(bytes[p]) : '.';
      } else hex += i === 7 ? '    ' : '   ';
    }
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex + ' ' + asc);
  }
  return lines.join('\n');
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Everything the cell viewer shows for one value. */
function describeCell(v, opts = {}) {
  const maxText = opts.maxText || 2 * 1024 * 1024;
  const maxImage = opts.maxImage || 8 * 1024 * 1024;
  if (v === null || v === undefined) return { kind: 'null' };
  if (typeof v === 'bigint') return { kind: 'integer', text: v.toString() };
  if (typeof v === 'number') return { kind: Number.isInteger(v) ? 'integer' : 'real', text: String(v) };
  if (v instanceof Uint8Array) {
    const kind = blobKind(v);
    const out = { kind: 'blob', size: v.length, blobKind: kind, hex: hexDump(v), hexCut: v.length > 4096 };
    if (IMAGE_KINDS.has(kind) && v.length <= maxImage) out.image = `data:${MIME[kind]};base64,` + Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
    const f32 = vectorStats(v, 4, 64);
    const f64 = v.length % 8 === 0 ? vectorStats(v, 8, 64) : null;
    if (f32 || f64) out.vectors = [f32, f64].filter(Boolean);
    return out;
  }
  const s = String(v);
  const out = { kind: 'text', length: s.length, text: s.length > maxText ? s.slice(0, maxText) : s, cut: s.length > maxText };
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); out.json = true; } catch { /* not JSON */ }
  }
  return out;
}

// ---------- export ----------

function csvField(v, sep) {
  if (v === null || v === undefined) return '';
  let s;
  if (v instanceof Uint8Array) s = '0x' + toHex(v);
  else s = typeof v === 'bigint' ? v.toString() : String(v);
  return /[",\r\n]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function jsonValue(v) {
  if (v instanceof Uint8Array) return '0x' + toHex(v);
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v === undefined ? null : v;
}

/** rows: arrays of raw values. format: csv | tsv | json | insert. */
function formatRows(columns, rows, format, opts = {}) {
  if (format === 'json') {
    const objs = rows.map(r => { const o = {}; columns.forEach((c, i) => { o[c] = jsonValue(r[i]); }); return o; });
    return JSON.stringify(objs, null, 2);
  }
  if (format === 'insert') {
    const t = quoteIdent(opts.table || 'query_result');
    const cols = columns.map(quoteIdent).join(', ');
    return rows.map(r => `INSERT INTO ${t} (${cols}) VALUES (${r.map(quoteValue).join(', ')});`).join('\n');
  }
  const sep = format === 'tsv' ? '\t' : ',';
  const lines = [];
  if (opts.header !== false) lines.push(columns.map(c => csvField(c, sep)).join(sep));
  for (const r of rows) lines.push(r.map(v => csvField(v, sep)).join(sep));
  return lines.join(format === 'tsv' ? '\n' : '\r\n');
}

module.exports = {
  HEADER, sniff, notSqliteMessage, friendlyOpenError, prepareBytes, quoteIdent, quoteValue, toHex,
  maskSql, trimStatement, checkReadOnly, filterClause, buildWhere, likeEscape, affinity, blobKind,
  encodeCell, vectorStats, hexDump, describeCell, formatRows, READ_PRAGMAS, GRID_TEXT,
};
