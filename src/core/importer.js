'use strict';
// CSV and TSV import into a new or existing table. Runs in the worker. The file is read in 1 MB chunks and
// decoded and parsed as a stream, so a 1M-row file never sits in memory as text. Rows go in through one prepared
// INSERT inside one savepoint: the import is one pending change, Undo removes all of it, and Cancel or an error
// rolls it back. Between chunks the worker yields, so Cancel and grid requests are handled during the import.

const fs = require('fs');
const path = require('path');
const U = require('./sqlutil');
const E = require('./edit');

const CHUNK = 1024 * 1024;
const PREVIEW_BYTES = 1024 * 1024;
const PREVIEW_ROWS = 200;
const ENCODINGS = new Set(['utf-8', 'utf-16le', 'windows-1252']);
const DELIMS = new Set([',', ';', '\t', '|']);

/** First rows of a CSV file, with the guessed encoding, delimiter, header and column types. */
function previewCsv(file, opts = {}) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Pick a file, not a folder.');
  const fd = fs.openSync(file, 'r');
  let head;
  try {
    const b = Buffer.alloc(Math.min(PREVIEW_BYTES, st.size));
    const n = fs.readSync(fd, b, 0, b.length, 0);
    head = b.subarray(0, n);
  } finally { fs.closeSync(fd); }
  if (looksBinary(head)) throw new Error(`${path.basename(file)} is not a text file. Pick a CSV or TSV file.`);
  const encoding = ENCODINGS.has(opts.encoding) ? opts.encoding : E.sniffEncoding(head);
  const dec = E.createDecoder(encoding);
  let text = dec.push(head);
  if (head.length === st.size) text += dec.end();
  const delimiter = DELIMS.has(opts.delimiter) ? opts.delimiter : (/\.tsv$|\.tab$/i.test(file) ? '\t' : E.detectDelimiter(text));
  const p = new E.CsvParser(delimiter);
  let rows = p.push(text);
  if (head.length === st.size) rows = rows.concat(p.end());
  const sample = rows.slice(0, PREVIEW_ROWS + 1);
  const ncols = sample.reduce((m, r) => Math.max(m, r.length), 0);
  const header = typeof opts.header === 'boolean' ? opts.header : guessHeader(sample);
  const body = header ? sample.slice(1) : sample;
  const names = header ? E.headerNames(sample[0], ncols) : E.headerNames([], ncols);
  const types = E.inferTypes(body, ncols);
  const parsedBytes = head.length;
  const estRows = head.length >= st.size ? rows.length - (header ? 1 : 0) : Math.round((rows.length - (header ? 1 : 0)) * (st.size / Math.max(1, parsedBytes)));
  return {
    file, name: path.basename(file), size: st.size, encoding, delimiter, header, names, types,
    rows: body.slice(0, PREVIEW_ROWS).map(r => r.slice(0, ncols)), estRows, exact: head.length >= st.size,
    table: E.tableNameFromFile(file),
  };
}

function looksBinary(b) {
  const n = Math.min(b.length, 8192);
  if (n >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return false; // UTF-16 BOM
  let zeros = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) zeros++;
  return zeros > 0;
}

/** A header row is likely when no cell of the first row is a number but some cell below it is. */
function guessHeader(rows) {
  if (rows.length < 2) return true;
  const isNum = s => /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(s);
  const first = rows[0];
  if (first.some(isNum)) return false;
  const uniq = new Set(first.map(s => s.trim().toLowerCase()));
  return uniq.size === first.length || rows.slice(1, 20).some(r => r.some(isNum));
}

/**
 * Run an import. session: an editing Session. o: {
 *   file, encoding, delimiter, header, mode: 'new' | 'existing', table,
 *   columns: [{ src: csv column index, name: target column, type: SQLite type (new table), transform? }]
 * }
 * onProgress({ rows, bytes, size }) is called about 4 times a second. isCancelled() is checked between chunks.
 * Resolves with { rows, short, long, ms } or rejects with an Error whose message is ready to show.
 */
async function runImport(session, o, onProgress, isCancelled) {
  const e = session.edit;
  if (!e) throw new Error('Click "Enable editing" first.');
  if (e.busy) throw new Error('An import is already running.');
  if (!DELIMS.has(o.delimiter)) throw new Error('Pick a delimiter.');
  if (!ENCODINGS.has(o.encoding)) throw new Error('Pick an encoding.');
  const cols = (o.columns || []).filter(c => c && Number.isInteger(c.src) && c.src >= 0 && c.name);
  if (!cols.length) throw new Error('Pick at least one column to import.');
  const table = String(o.table || '').trim();
  if (!table) throw new Error('Type a table name.');
  const exists = session.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE", [table]).rows.length > 0;
  if (o.mode === 'new' && exists) throw new Error(`A table named ${table} already exists. Pick another name, or import into the existing table.`);
  if (o.mode === 'existing' && !exists) throw new Error(`There is no table named ${table}.`);
  if (new Set(cols.map(c => c.name.toLowerCase())).size !== cols.length) throw new Error('Two columns have the same target name.');

  const t0 = Date.now();
  const st = await fs.promises.stat(o.file);
  const fh = await fs.promises.open(o.file, 'r');
  const id = ++e.seq;
  const sp = `zovo_edit_${id}`;
  const db = session.db;
  e.busy = 'import';
  db.run(`SAVEPOINT ${sp}`);
  let stmt = null;
  let rows = 0, short = 0, long = 0, line = 0;
  let createSql = '';
  try {
    if (o.mode === 'new') {
      createSql = `CREATE TABLE ${U.quoteIdent(table)} (${cols.map(c => `${U.quoteIdent(c.name)} ${sanitizeType(c.type)}`.trim()).join(', ')})`;
      db.run(createSql);
    }
    const insertSql = `INSERT INTO ${U.quoteIdent(table)} (${cols.map(c => U.quoteIdent(c.name)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    stmt = db.prepare(insertSql);
    let affinities = cols.map(c => c.type || '');
    if (o.mode === 'existing') {
      const decl = new Map(session.all(`PRAGMA table_info(${U.quoteIdent(table)})`).rows.map(r => [String(r[1]).toLowerCase(), String(r[2] || '')]));
      affinities = cols.map(c => decl.get(c.name.toLowerCase()) || '');
    }
    const dec = E.createDecoder(o.encoding);
    const parser = new E.CsvParser(o.delimiter);
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let skipHeader = !!o.header;
    let lastTick = Date.now();
    const insertRows = list => {
      for (const r of list) {
        line = r.line || line;
        if (skipHeader) { skipHeader = false; continue; }
        if (r.length < cols.length) short++;
        const vals = new Array(cols.length);
        for (let i = 0; i < cols.length; i++) vals[i] = E.csvValue(r[cols[i].src], affinities[i], cols[i].transform && cols[i].transform !== 'none' ? cols[i].transform : null);
        if (r.length > cols.reduce((m, c) => Math.max(m, c.src + 1), 0) && o.mode === 'existing') long++;
        stmt.bind(vals);
        stmt.step();
        stmt.reset();
        rows++;
      }
    };
    for (;;) {
      if (isCancelled()) throw Object.assign(new Error('Import cancelled. Nothing was added.'), { cancelled: true });
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      insertRows(parser.push(dec.push(buf.subarray(0, bytesRead))));
      if (Date.now() - lastTick > 250) { lastTick = Date.now(); onProgress({ rows, bytes: pos, size: st.size }); }
      await new Promise(r => setImmediate(r));
    }
    insertRows(parser.push(dec.end()));
    insertRows(parser.end());
    stmt.free();
    stmt = null;
  } catch (err) {
    if (stmt) try { stmt.free(); } catch { /* freed */ }
    try { db.run(`ROLLBACK TO ${sp}`); db.run(`RELEASE ${sp}`); } catch { /* gone */ }
    e.busy = '';
    await fh.close().catch(() => {});
    if (err.cancelled) throw err;
    const { constraintMessage } = require('./editing');
    throw new Error(`Import stopped at line ${line.toLocaleString('en-US')} of ${path.basename(o.file)}: ${constraintMessage(err)} Nothing was added.`);
  }
  await fh.close().catch(() => {});
  e.busy = '';
  const label = `Import ${rows.toLocaleString('en-US')} rows from ${path.basename(o.file)} into ${o.mode === 'new' ? 'new table ' : ''}${table}`;
  const sqlText = (createSql ? createSql + ';\n' : '') + `INSERT INTO ${U.quoteIdent(table)} (${cols.map(c => U.quoteIdent(c.name)).join(', ')}) VALUES (…); -- × ${rows.toLocaleString('en-US')} rows`;
  e.pending.push({ id, sp, label, sql: sqlText, ddl: o.mode === 'new' });
  return { rows, short, long, ms: Date.now() - t0, table };
}

function sanitizeType(t) {
  const s = String(t || '').toUpperCase().replace(/[^A-Z0-9 (),]/g, '').trim();
  return s.slice(0, 40);
}

module.exports = { previewCsv, runImport, guessHeader, looksBinary, PREVIEW_ROWS };
