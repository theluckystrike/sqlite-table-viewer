'use strict';
// Pure helpers for editing mode: which SQL may run as a staged change, typed cell values, the SQL text shown
// in the pending list, and a streaming CSV/TSV reader with type guessing. No fs, no sql.js, no vscode.

const U = require('./sqlutil');

// ---------- statements in the SQL box while editing ----------

const BLOCKED = /\b(attach|detach|vacuum|begin|commit|rollback|savepoint|release|end\s+transaction)\b/i;
const WRITE_FIRST = new Set(['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'with', 'reindex', 'analyze']);
const DDL = /^\s*(create|drop|alter)\b/i;

/**
 * May this statement run as a staged change? Returns { ok, ddl, message }.
 * Transaction control, ATTACH and VACUUM are refused: the editor owns the transaction, and Save writes the file.
 */
function checkWrite(sql) {
  const masked = U.maskSql(sql);
  const parts = masked.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, message: 'Type a statement.' };
  if (parts.length > 1) return { ok: false, message: 'Run one statement at a time.' };
  const body = parts[0];
  const first = (body.match(/^[a-z]+/i) || [''])[0].toLowerCase();
  if (BLOCKED.test(body)) return { ok: false, message: 'BEGIN, COMMIT, ROLLBACK, SAVEPOINT, ATTACH and VACUUM do not run here. Every change is staged, and Save writes them all in one step.' };
  if (first === 'pragma') return { ok: false, message: 'PRAGMA assignments do not run here. Only reading PRAGMAs run.' };
  if (!WRITE_FIRST.has(first)) return { ok: false, message: 'Only SELECT, INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP and ALTER statements run here.' };
  return { ok: true, ddl: DDL.test(body) };
}

// ---------- typed values ----------

const INT_RE = /^[+-]?\d+$/;
const REAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const HEX_RE = /^(0x|x')?([0-9a-f\s]*)'?$/i;

/**
 * Turn an edit from the webview into a value sql.js can bind. v = { t, v }:
 * t 'text' | 'int' | 'real' | 'null' | 'hex' | 'auto' (auto: by the column's affinity, like SQLite would store it).
 * Returns { ok, value, message }.
 */
function toValue(v, affinity) {
  if (!v || typeof v !== 'object') return { ok: false, message: 'No value.' };
  const s = typeof v.v === 'string' ? v.v : '';
  switch (v.t) {
    case 'null': return { ok: true, value: null };
    case 'text': return { ok: true, value: s };
    case 'int': {
      const t = s.trim();
      if (!INT_RE.test(t)) return { ok: false, message: `"${short(s)}" is not a whole number.` };
      const b = BigInt(t);
      if (b > 9223372036854775807n || b < -9223372036854775808n) return { ok: false, message: 'The number is outside the 64-bit INTEGER range.' };
      return { ok: true, value: Number.isSafeInteger(Number(b)) ? Number(b) : b };
    }
    case 'real': {
      const t = s.trim();
      if (!REAL_RE.test(t)) return { ok: false, message: `"${short(s)}" is not a number.` };
      return { ok: true, value: Number(t) };
    }
    case 'hex': {
      const m = s.trim().match(HEX_RE);
      const hex = m ? m[2].replace(/\s+/g, '') : null;
      if (hex === null || hex.length % 2) return { ok: false, message: 'Type the BLOB as hex digits, two per byte (for example 89504e47).' };
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return { ok: true, value: out };
    }
    case 'auto': {
      const t = s.trim();
      if (affinity === 'int' && INT_RE.test(t)) return toValue({ t: 'int', v: t });
      if ((affinity === 'int' || affinity === 'float' || affinity === 'decimal' || affinity === 'any') && REAL_RE.test(t) && !/^[+-]?0\d/.test(t)) {
        return INT_RE.test(t) ? toValue({ t: 'int', v: t }) : { ok: true, value: Number(t) };
      }
      return { ok: true, value: s };
    }
    default: return { ok: false, message: 'Unknown value type.' };
  }
}

function short(s) { s = String(s); return s.length > 40 ? s.slice(0, 40) + '…' : s; }

/** SQL text with the bound values written in, for the pending list. BLOBs over 32 bytes are shortened. */
function inlineParams(sql, params) {
  let i = 0;
  if (!params || !params.length) return sql;
  // Replace the ? placeholders outside quotes, in order.
  let out = '';
  for (let k = 0; k < sql.length; k++) {
    if (sql[k] === '?' && i < params.length && isPlaceholder(sql, k)) { out += preview(params[i++]); continue; }
    out += sql[k];
  }
  return out;
}

function isPlaceholder(sql, k) {
  // A ? inside a quoted string or identifier is not a placeholder. The statements built here only put ? outside quotes,
  // so counting quotes before k is enough.
  let q = 0, d = 0;
  for (let j = 0; j < k; j++) { if (sql[j] === "'") q++; else if (sql[j] === '"') d++; }
  return q % 2 === 0 && d % 2 === 0;
}

function preview(v) {
  if (v instanceof Uint8Array && v.length > 32) return `X'${U.toHex(v.subarray(0, 16))}…' /* ${v.length} bytes */`;
  if (typeof v === 'string' && v.length > 200) return U.quoteValue(v.slice(0, 200)) + ` /* … ${v.length} characters */`;
  return U.quoteValue(v);
}

/** Default values for a new row: NULL, except NOT NULL columns with no default (0 for numbers, '' for the rest). */
function newRowValues(columns) {
  const cols = [];
  const vals = [];
  for (const c of columns) {
    if (c.hidden) continue;
    if (c.notnull && c.dflt === null && !c.rowidAlias) {
      cols.push(c.name);
      const a = U.affinity(c.type);
      vals.push(a === 'int' || a === 'float' || a === 'decimal' || a === 'bool' ? 0 : a === 'blob' ? new Uint8Array(0) : '');
    }
  }
  return { cols, vals };
}

// ---------- text decoding ----------

// Windows-1252 bytes 0x80-0x9F. The rest of the range is the same as Latin-1.
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

function decode1252(bytes) {
  let s = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    const end = Math.min(bytes.length, i + CH);
    const codes = new Array(end - i);
    for (let j = i; j < end; j++) { const b = bytes[j]; codes[j - i] = b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : b; }
    s += String.fromCharCode.apply(null, codes);
  }
  return s;
}

/** A streaming decoder: push(bytes) returns text, end() returns the rest. encoding: utf-8 | utf-16le | windows-1252. */
function createDecoder(encoding) {
  if (encoding === 'windows-1252') return { push: b => decode1252(b), end: () => '' };
  const td = new TextDecoder(encoding === 'utf-16le' ? 'utf-16le' : 'utf-8', { fatal: false, ignoreBOM: false });
  return { push: b => td.decode(b, { stream: true }), end: () => td.decode() };
}

/** Guess the encoding from the first bytes: a BOM, else UTF-8 when the bytes are valid UTF-8, else Windows-1252. */
function sniffEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  try {
    // The sample may end inside a character: drop up to 3 trailing bytes of an incomplete sequence.
    let n = bytes.length;
    for (let k = 0; k < 3 && n > 0 && (bytes[n - 1] & 0xc0) === 0x80; k++) n--;
    if (n > 0 && bytes[n - 1] >= 0xc0) n--;
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n));
    return 'utf-8';
  } catch { return 'windows-1252'; }
}

// ---------- CSV ----------

/** Pick the delimiter that splits the first lines into the most stable number of fields. */
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length).slice(0, 30);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map(l => splitQuotedCount(l, d));
    if (!counts.length || counts[0] < 2) continue;
    const same = counts.filter(c => c === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitQuotedCount(line, d) {
  let n = 1, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/**
 * Streaming CSV parser (RFC 4180 plus: any delimiter, quoted newlines, "" inside quotes, CRLF or LF, a BOM at the start).
 * push(text) returns the rows completed by this chunk. end() returns the last row, if any.
 */
class CsvParser {
  constructor(delimiter) {
    this.d = delimiter || ',';
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quoteSeen = false; // a quote just closed; the next char decides between "" and the end of the field
    this.started = false;
    this.line = 1;
    this.rowLine = 1;
  }

  push(text) {
    const rows = [];
    const d = this.d;
    let i = 0;
    if (!this.started && text.length) { this.started = true; if (text.charCodeAt(0) === 0xfeff) i = 1; }
    let field = this.field;
    let start = i;
    for (; i < text.length; i++) {
      const c = text[i];
      if (this.inQuotes) {
        if (c === '"') { field += text.slice(start, i); this.inQuotes = false; this.quoteSeen = true; start = i + 1; }
        else if (c === '\n') this.line++;
        continue;
      }
      if (this.quoteSeen) {
        this.quoteSeen = false;
        if (c === '"') { field += '"'; this.inQuotes = true; start = i + 1; continue; }
      }
      if (c === '"' && start === i && field === '') { this.inQuotes = true; start = i + 1; continue; }
      if (c === d) { this.row.push(field + text.slice(start, i)); field = ''; start = i + 1; continue; }
      if (c === '\n' || c === '\r') {
        this.row.push(field + text.slice(start, i));
        field = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
        // Blank lines are skipped. That also covers a \r\n split across two chunks.
        if (!(this.row.length === 1 && this.row[0] === '')) { this.row.line = this.rowLine; rows.push(this.row); }
        this.row = [];
        this.line++;
        this.rowLine = this.line;
        continue;
      }
    }
    field += text.slice(start, i);
    this.field = field;
    return rows;
  }

  end() {
    if (this.inQuotes || this.field !== '' || this.row.length) {
      this.row.push(this.field);
      this.field = '';
      const r = this.row;
      this.row = [];
      if (!(r.length === 1 && r[0] === '')) { r.line = this.rowLine; return [r]; }
    }
    return [];
  }
}

/** Parse a whole string (tests and previews). */
function parseCsv(text, delimiter) {
  const p = new CsvParser(delimiter);
  return [...p.push(text), ...p.end()];
}

/** Guess a SQLite type for each column from sample rows: INTEGER, REAL or TEXT. Empty cells are ignored. */
function inferTypes(rows, ncols) {
  const types = [];
  for (let c = 0; c < ncols; c++) {
    let isInt = true, isReal = true, seen = 0;
    for (const r of rows) {
      const v = r[c];
      if (v === undefined || v === '') continue;
      seen++;
      const t = v.trim();
      if (/^[+-]?0\d/.test(t)) { isInt = isReal = false; break; } // leading zeros (ZIP codes, IDs) stay text
      if (isInt && !(INT_RE.test(t) && Number.isSafeInteger(Number(t)))) isInt = false;
      if (isReal && !REAL_RE.test(t)) isReal = false;
      if (!isInt && !isReal) break;
    }
    types.push(!seen ? 'TEXT' : isInt ? 'INTEGER' : isReal ? 'REAL' : 'TEXT');
  }
  return types;
}

/** Column names from a header row: trimmed, unique, never empty. */
function headerNames(row, ncols) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < ncols; i++) {
    let n = String(row && row[i] !== undefined ? row[i] : '').trim() || `column${i + 1}`;
    const key = n.toLowerCase();
    if (seen.has(key)) { const k = seen.get(key) + 1; seen.set(key, k); n = `${n}_${k}`; } else seen.set(key, 1);
    out.push(n);
  }
  return out;
}

/** A CSV text cell as the value to insert, by the target column type. Empty text becomes NULL for numeric columns. */
function csvValue(s, type, transform) {
  if (s === undefined) return null;
  if (transform) s = applyTransform(s, transform);
  if (s === null) return null;
  const t = String(type || '').toUpperCase();
  if (t.includes('INT')) {
    const x = s.trim();
    if (x === '') return null;
    if (INT_RE.test(x)) { const n = Number(x); return Number.isSafeInteger(n) ? n : s; }
    if (REAL_RE.test(x)) return Number(x);
    return s;
  }
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) {
    const x = s.trim();
    if (x === '') return null;
    return REAL_RE.test(x) ? Number(x) : s;
  }
  return s;
}

/** Column transforms for CSV import (Pro candidate): trim, lower, upper, empty-null, digits (strip thousands separators). */
const TRANSFORMS = ['none', 'trim', 'lower', 'upper', 'empty-null', 'number'];
function applyTransform(s, t) {
  switch (t) {
    case 'trim': return s.trim();
    case 'lower': return s.toLowerCase();
    case 'upper': return s.toUpperCase();
    case 'empty-null': return s.trim() === '' ? null : s;
    case 'number': {
      const x = s.trim().replace(/[\s,_']/g, '');
      return REAL_RE.test(x) ? x : s;
    }
    default: return s;
  }
}

/** A table name that SQLite will accept as is (quoted), from a file name. */
function tableNameFromFile(file) {
  const base = String(file).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim();
  return base.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'imported';
}

module.exports = {
  checkWrite, toValue, inlineParams, newRowValues, decode1252, createDecoder, sniffEncoding, detectDelimiter,
  CsvParser, parseCsv, inferTypes, headerNames, csvValue, applyTransform, TRANSFORMS, tableNameFromFile,
};
