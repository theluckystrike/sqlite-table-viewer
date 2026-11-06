'use strict';
// Pure display helpers for grid cells (no DOM), so they can be unit tested in Node.

const BLOB_LABEL = { png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', float32: 'vector?', 'gpkg-geometry': 'geometry', binary: '' };

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Text and CSS class for an encoded cell (see sqlutil.encodeCell). */
function display(v) {
  if (v === null || v === undefined) return { text: '', cls: 'null' };
  if (typeof v === 'number') return { text: String(v), cls: 'num' };
  if (typeof v === 'string') return { text: oneLine(v), cls: '' };
  if (typeof v === 'object') {
    if (typeof v.i === 'string') return { text: v.i, cls: 'num' };
    if (typeof v.t === 'string') return { text: oneLine(v.t) + '…', cls: '' };
    if (typeof v.b === 'number') {
      const label = BLOB_LABEL[v.k] || '';
      return { text: `BLOB ${formatBytes(v.b)}${label ? ' · ' + label : ''}`, cls: 'blob' };
    }
  }
  return { text: String(v), cls: '' };
}

function oneLine(s) {
  return s.length > 300 ? s.slice(0, 300).replace(/\r?\n/g, ' ⏎ ') : s.replace(/\r?\n/g, ' ⏎ ');
}

function kindLabel(v) {
  if (!v) return '';
  if (v.kind === 'blob') return `BLOB · ${formatBytes(v.size)}` + (v.blobKind && v.blobKind !== 'binary' ? ` · ${v.blobKind}` : '');
  if (v.kind === 'text') return v.json ? 'JSON text' : 'TEXT';
  return v.kind.toUpperCase();
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function num(x) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  return a !== 0 && (a < 1e-4 || a >= 1e6) ? x.toExponential(4) : String(Number(x.toPrecision(6)));
}

function shortCount(n) {
  if (n === null || n === undefined) return '?';
  if (n < 10000) return Number(n).toLocaleString('en-US');
  if (n < 1e6) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

module.exports = { display, kindLabel, prettyJson, num, shortCount, formatBytes };
