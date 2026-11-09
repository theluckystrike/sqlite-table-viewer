'use strict';
// Worker thread for the Zovo Pro tools (compare, ER diagram, export all tables). It reads the database files (and
// their -wal) into memory, runs one job and writes the output files. It never writes to a database file.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-wasm.js');
const U = require('./core/sqlutil');
const { applyWal } = require('./core/wal');
const P = require('./core/protools');
const { zipFiles } = require('./core/zip');

let SQL = null;

function openDb(file, maxBytes) {
  const size = fs.statSync(file).size;
  if (maxBytes && size > maxBytes) throw new Error(`${path.basename(file)} is ${(size / 1048576).toFixed(0)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB limit (sqliteTableViewer.maxFileSizeMB).`);
  let bytes = fs.readFileSync(file);
  if (U.sniff(bytes) === 'other' && bytes.length) throw new Error(`${path.basename(file)} is not a SQLite database (no "SQLite format 3" header).`);
  let wal = null;
  try { wal = fs.readFileSync(file + '-wal'); } catch { /* no WAL file */ }
  if (wal && wal.length) { const r = applyWal(bytes, wal); if (r.applied) bytes = r.bytes; }
  try {
    const db = new SQL.Database(U.prepareBytes(bytes));
    db.exec('SELECT count(*) FROM sqlite_master');
    return db;
  } catch (e) {
    throw new Error(`${path.basename(file)}: ${U.friendlyOpenError(e)}`);
  }
}

/** Writes through a temporary file and renames it at the end, so a failed job leaves no half file. */
function fileSink(target) {
  const tmp = `${target}.${process.pid}.part`;
  const fd = fs.openSync(tmp, 'w');
  let bytes = 0;
  return {
    write(s) { const b = Buffer.from(s, 'utf8'); fs.writeSync(fd, b); bytes += b.length; },
    done() { fs.closeSync(fd); fs.renameSync(tmp, target); return bytes; },
    abort() { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(tmp); } catch { /* gone */ } },
  };
}

function writeAtomic(target, data) {
  const s = fileSink(target);
  try { s.write(data); return s.done(); } catch (e) { s.abort(); throw e; }
}

function compare(job) {
  const a = openDb(job.a, job.maxBytes);
  const b = openDb(job.b, job.maxBytes);
  const sink = fileSink(job.script);
  try {
    const r = P.compareDatabases(a, b, sink, {
      labelA: path.basename(job.a), labelB: path.basename(job.b), pathA: job.a, pathB: job.b,
      scriptName: path.basename(job.script), maxStatements: job.maxStatements,
    });
    const scriptBytes = sink.done();
    const reportBytes = writeAtomic(job.report, r.report);
    return { summary: r.summary, statements: r.statements, capped: r.capped, same: r.same, files: [job.report, job.script], bytes: reportBytes + scriptBytes };
  } catch (e) {
    sink.abort();
    throw e;
  } finally { a.close(); b.close(); }
}

function erd(job) {
  const db = openDb(job.db, job.maxBytes);
  try {
    const model = P.schemaModel(db);
    const title = path.basename(job.db);
    const svg = P.erSvg(model, { title });
    const mmd = P.erMermaid(model);
    const doc = P.schemaMarkdown(model, { title, path: job.db, svgName: path.basename(job.svg), mmdName: path.basename(job.mmd) });
    writeAtomic(job.svg, svg);
    writeAtomic(job.mmd, mmd);
    writeAtomic(job.md, doc);
    return { tables: model.tables.length, fks: model.tables.reduce((n, t) => n + t.fks.length, 0), views: model.views.length, files: [job.md, job.svg, job.mmd] };
  } finally { db.close(); }
}

function exportAll(job) {
  const db = openDb(job.db, job.maxBytes);
  try {
    if (job.format === 'xlsx') {
      const w = P.workbookParts(db, { maxRows: job.maxRows });
      writeAtomic(job.out, zipFiles(w.files));
      return { format: 'xlsx', tables: w.sheets, files: [job.out] };
    }
    fs.mkdirSync(job.out, { recursive: true });
    const sinks = new Map();
    try {
      const res = P.csvTables(db, (file, text) => {
        if (!sinks.has(file)) sinks.set(file, fileSink(path.join(job.out, file)));
        sinks.get(file).write(text);
      }, { maxRows: job.maxRows });
      for (const s of sinks.values()) s.done();
      return { format: 'csv', tables: res, files: res.map(r => path.join(job.out, r.file)) };
    } catch (e) {
      for (const s of sinks.values()) s.abort();
      throw e;
    }
  } finally { db.close(); }
}

parentPort.on('message', async job => {
  try {
    if (!SQL) SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(__dirname, 'sql-wasm.wasm')) });
    const t0 = Date.now();
    const fn = { compare, erd, exportAll }[job.type];
    if (!fn) throw new Error(`Unknown job ${job.type}`);
    const result = fn(job);
    parentPort.postMessage({ ok: true, result: { ...result, ms: Date.now() - t0 } });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
});
