'use strict';
// One open database. Runs in a worker thread in the extension host. Takes webview messages that
// protocol.js has already checked, and returns the messages to send back. sql.js keeps the
// database in memory. Nothing here writes to the file: editing.js stages changes, and writeback.js
// writes them only when the user clicks Save.

const U = require('./sqlutil');
const { applyWal } = require('./wal');

const PAGE_MAX = 1000;
const LIST_MAX = 100000;
const COUNT_ALL_BELOW = 100 * 1024 * 1024; // count every table exactly when the file is smaller
const COUNT_VIEWS_BELOW = 20 * 1024 * 1024;
// Views and SQL-box queries can return rows without end (WITH RECURSIVE with no stop). Their counts stop at a cap,
// so a crafted or careless view cannot keep the worker busy forever.
const VIEW_LIST_COUNT_CAP = 1000000; // the object list shows the button "count" above this
const ROW_COUNT_CAP = 10000000; // paging over a view or query stops here

function now() { return Number(process.hrtime.bigint() / 1000000n); }

class Session {
  /**
   * @param SQL sql.js module
   * @param {Uint8Array} bytes file contents
   * @param {{fileSize?:number, exportMaxRows?:number, copyMaxRows?:number}} opts
   */
  constructor(SQL, bytes, opts = {}) {
    this.opts = opts;
    this.fileSize = opts.fileSize || bytes.length;
    this.db = new SQL.Database(U.prepareBytes(bytes));
    this.db.run('PRAGMA query_only = ON');
    this.version = 0;
    this.source = null;
    this.objects = null;
    // Fail early with a clear message when the header is fine but the content is not.
    this.objects = this.listObjects();
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  all(sql, params, max = Infinity) {
    const st = this.db.prepare(sql);
    try {
      if (params && params.length) st.bind(params);
      const rows = [];
      while (rows.length < max && st.step()) rows.push(st.get(null, { useBigInt: true }));
      return { columns: st.getColumnNames(), rows, more: rows.length >= max && st.step() };
    } finally { st.free(); }
  }

  one(sql, params) {
    const r = this.all(sql, params, 1).rows[0];
    return r ? r[0] : null;
  }

  // ---------- objects ----------
  listObjects() {
    const rows = this.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name").rows;
    const out = { tables: [], views: [], indexes: [], triggers: [] };
    let stats = null;
    if (this.fileSize >= COUNT_ALL_BELOW) {
      try { stats = new Map(this.all('SELECT tbl, MAX(CAST(stat AS INTEGER)) FROM sqlite_stat1 GROUP BY tbl').rows.map(r => [r[0], Number(r[1])])); } catch { stats = null; }
    }
    for (const [type, name, tbl, sql] of rows) {
      const s = sql || '';
      if (type === 'table') {
        const t = { name, rows: null, estimate: false, withoutRowid: /\bwithout\s+rowid\s*$/i.test(s.trim()), virtual: /^create\s+virtual/i.test(s.trim()), system: name.startsWith('sqlite_') };
        if (this.fileSize < COUNT_ALL_BELOW) t.rows = this.safeCount(name);
        else if (stats && stats.has(name)) { t.rows = stats.get(name); t.estimate = true; }
        out.tables.push(t);
      } else if (type === 'view') {
        out.views.push({ name, rows: this.fileSize < COUNT_VIEWS_BELOW ? this.safeCount(name, this.opts.viewListCountCap || VIEW_LIST_COUNT_CAP) : null });
      } else if (type === 'index') {
        out.indexes.push({ name, table: tbl, unique: /^create\s+unique/i.test(s.trim()), sql: s });
      } else if (type === 'trigger') {
        out.triggers.push({ name, table: tbl, sql: s });
      }
    }
    return out;
  }

  /** Exact row count, or with cap: the count when it is at most cap, else null. */
  safeCount(name, cap) {
    try {
      if (!cap) return Number(this.one(`SELECT COUNT(*) FROM ${U.quoteIdent(name)}`));
      const n = Number(this.one(`SELECT COUNT(*) FROM (SELECT 1 FROM ${U.quoteIdent(name)} LIMIT ${cap + 1})`));
      return n > cap ? null : n;
    } catch { return null; }
  }

  objectsMessage() {
    let info = {};
    try {
      info = {
        pageSize: Number(this.one('PRAGMA page_size')),
        pageCount: Number(this.one('PRAGMA page_count')),
        encoding: String(this.one('PRAGMA encoding')),
        userVersion: Number(this.one('PRAGMA user_version')),
        sqliteVersion: String(this.one('SELECT sqlite_version()')),
      };
    } catch { /* corrupt header fields */ }
    return { type: 'objects', ...this.objects, info: { ...info, fileSize: this.fileSize } };
  }

  findObject(name) {
    const o = this.objects;
    return o.tables.find(t => t.name === name) || o.views.find(v => v.name === name) || null;
  }

  // ---------- sources ----------
  /** Show a table or view in the grid. */
  openTable(name) {
    const obj = this.findObject(name);
    if (!obj) return [{ type: 'error', message: `No table or view named ${name}.`, transient: true }];
    const isTable = this.objects.tables.includes(obj);
    let declared = [];
    try { declared = this.all(`PRAGMA table_xinfo(${U.quoteIdent(name)})`).rows.filter(r => Number(r[6] || 0) === 0 || Number(r[6]) === 2 || Number(r[6]) === 3); } catch { declared = []; }
    const info = new Map(declared.map(r => [String(r[1]), { notnull: Number(r[3]) === 1, dflt: r[4] === null ? null : String(r[4]), pkn: Number(r[5]), generated: Number(r[6] || 0) >= 2 }]));
    const from = U.quoteIdent(name);
    let columns;
    try { columns = this.all(`SELECT * FROM ${from} LIMIT 0`).columns; } catch (e) {
      return [{ type: 'error', message: `${name} cannot be read: ${U.friendlyOpenError(e)}`, transient: true }];
    }
    const types = new Map(declared.map(r => [String(r[1]), String(r[2] || '')]));
    const pk = new Set(declared.filter(r => Number(r[5]) > 0).map(r => String(r[1])));
    const useRowid = isTable && !obj.withoutRowid && !obj.virtual && !columns.some(c => /^(rowid|_rowid_|oid)$/i.test(c));
    // The row key for edits: a rowid name that no column hides, or the primary key of a WITHOUT ROWID table.
    let key = null;
    if (isTable && !obj.virtual && !obj.system) {
      const alias = obj.withoutRowid ? null : ['_rowid_', 'rowid', 'oid'].find(a => !columns.some(c => c.toLowerCase() === a));
      if (alias) key = [alias];
      else if (pk.size) key = declared.filter(r => Number(r[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5])).map(r => U.quoteIdent(String(r[1])));
    }
    const pkCount = pk.size;
    this.source = {
      kind: 'table', name, from, isTable, rowid: useRowid ? '_rowid_' : null, key,
      columns: columns.map(c => {
        const i = info.get(c) || {};
        const declaredType = types.get(c) || '';
        return {
          name: c, declared: declaredType, type: U.affinity(declaredType), pk: pk.has(c), notnull: !!i.notnull, dflt: i.dflt === undefined ? null : i.dflt,
          generated: !!i.generated, rowidAlias: !obj.withoutRowid && pkCount === 1 && pk.has(c) && declaredType.toUpperCase() === 'INTEGER',
        };
      }),
      sort: null, filters: { global: '', columns: {} }, canFilter: true,
    };
    return this.refresh(true);
  }

  /** Run a statement from the SQL box. */
  runSql(sql) {
    const check = U.checkReadOnly(sql);
    if (!check.ok && this.edit && this.runWriteSql) return this.runWriteSql(sql, check);
    if (!check.ok) return [{ type: 'sqlError', message: check.message }];
    const t0 = now();
    try {
      if (check.mode === 'select') {
        const inner = U.trimStatement(sql);
        const from = `(\n${inner}\n)`;
        const columns = this.all(`SELECT * FROM ${from} LIMIT 0`).columns;
        this.source = {
          kind: 'query', sql: inner, from, isTable: false, rowid: null,
          columns: columns.map(c => ({ name: c, declared: '', type: 'any', pk: false })),
          sort: null, filters: { global: '', columns: {} }, canFilter: true,
        };
      } else {
        const r = this.all(U.trimStatement(sql), [], LIST_MAX);
        this.source = {
          kind: 'list', sql: U.trimStatement(sql), from: null, isTable: false, rowid: null, list: r.rows, listMore: r.more,
          columns: r.columns.map(c => ({ name: c, declared: '', type: 'any', pk: false })),
          sort: null, filters: { global: '', columns: {} }, canFilter: false,
        };
      }
      const out = this.refresh(true);
      out.push({ type: 'sqlDone', ms: now() - t0, rows: this.viewCount, more: !!this.source.listMore });
      return out;
    } catch (e) {
      return [{ type: 'sqlError', message: U.friendlyOpenError(e) }];
    }
  }

  // ---------- view (sort + filters) ----------
  whereSql() {
    const s = this.source;
    return U.buildWhere(s.columns.map(c => c.name), s.filters);
  }

  orderSql() {
    const s = this.source;
    // Tables always end the ORDER BY with their row key. Without it SQLite may walk a covering index instead of the
    // table, and two queries for the same row number (the grid and an edit) could see different rows.
    const key = s.key ? s.key.join(', ') : s.rowid;
    if (!s.sort) return key ? ` ORDER BY ${key}` : '';
    const c = s.columns[s.sort.col];
    if (!c) return key ? ` ORDER BY ${key}` : '';
    const dir = s.sort.dir === 'desc' ? 'DESC' : 'ASC';
    return ` ORDER BY ${U.quoteIdent(c.name)} ${dir} NULLS LAST` + (key ? `, ${key}` : '');
  }

  refresh(isNew, keepSel) {
    const s = this.source;
    const t0 = now();
    this.version++;
    if (s.kind === 'list') {
      this.viewCount = s.list.length;
    } else {
      const w = this.whereSql();
      this.viewCount = s.isTable
        ? Number(this.one(`SELECT COUNT(*) FROM ${s.from}${w.sql}`, w.params))
        : Number(this.one(`SELECT COUNT(*) FROM (SELECT 1 FROM ${s.from}${w.sql} LIMIT ${this.opts.rowCountCap || ROW_COUNT_CAP})`, w.params));
    }
    const ms = now() - t0;
    if (!isNew) return [{ type: 'view', version: this.version, viewCount: this.viewCount, sort: s.sort, ms, keepSel: !!keepSel }];
    return [this.metaMessage(ms)];
  }

  metaMessage(ms) {
    const s = this.source;
    return {
      type: 'meta', version: this.version,
      source: { kind: s.kind, name: s.name || null, sql: s.sql || null },
      columns: s.columns.map(c => ({ name: c.name, type: c.type, declared: c.declared, pk: c.pk, generated: !!c.generated })),
      viewCount: this.viewCount, sort: s.sort, filters: s.filters, canFilter: s.canFilter, ms: ms || 0,
      listMore: !!s.listMore, editable: this.editableReason ? this.editableReason() : null,
    };
  }

  setSort(col, dir) {
    if (!this.source) return [];
    if (col === null || !this.source.canFilter) this.source.sort = null;
    else if (col >= 0 && col < this.source.columns.length) this.source.sort = { col, dir: dir === 'desc' ? 'desc' : 'asc' };
    return this.refresh(false);
  }

  setFilters(global, columns) {
    if (!this.source || !this.source.canFilter) return [];
    this.source.filters = { global: global || '', columns: columns || {} };
    try { return this.refresh(false); } catch (e) {
      this.source.filters = { global: '', columns: {} };
      return [{ type: 'error', message: U.friendlyOpenError(e), transient: true }, ...this.refresh(false)];
    }
  }

  /** Raw rows [start, start+count) of the current view, as arrays of sql.js values. */
  rawRows(start, count, colIdx) {
    const s = this.source;
    if (s.kind === 'list') {
      const rows = s.list.slice(start, start + count);
      return colIdx ? rows.map(r => colIdx.map(i => r[i])) : rows;
    }
    const w = this.whereSql();
    const sel = colIdx ? colIdx.map(i => U.quoteIdent(s.columns[i].name)).join(', ') : '*';
    const sql = `SELECT ${sel} FROM ${s.from}${w.sql}${this.orderSql()} LIMIT ? OFFSET ?`;
    return this.all(sql, [...w.params, count, start]).rows;
  }

  getRows(reqId, start, count) {
    if (!this.source) return [];
    const n = Math.max(0, Math.min(PAGE_MAX, count));
    const rows = this.rawRows(start, n).map((r, i) => ({ id: start + i, cells: r.map(U.encodeCell) }));
    return [{ type: 'rows', reqId, version: this.version, rows }];
  }

  cell(row, col) {
    if (!this.source || col < 0 || col >= this.source.columns.length) return [];
    const r = this.rawRows(row, 1, [col])[0];
    if (!r) return [{ type: 'error', message: 'That row is no longer in view.', transient: true }];
    return [{ type: 'cell', row, col, column: this.source.columns[col].name, value: U.describeCell(r[0]) }];
  }

  count(name) {
    const obj = this.findObject(name);
    if (!obj) return [];
    obj.rows = this.safeCount(name);
    obj.estimate = false;
    return [{ type: 'count', name, rows: obj.rows }];
  }

  // ---------- schema ----------
  schema(name) {
    const master = this.all('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ?', [name]).rows[0];
    if (!master) return [{ type: 'error', message: `No object named ${name}.`, transient: true }];
    const [type, , tbl, sql] = master;
    const out = { type: 'schema', name, objectType: type, table: tbl, sql: sql || '', columns: [], foreignKeys: [], indexes: [], triggers: [] };
    if (type === 'table' || type === 'view') {
      const q = U.quoteIdent(name);
      try {
        out.columns = this.all(`PRAGMA table_xinfo(${q})`).rows.map(r => ({
          cid: Number(r[0]), name: String(r[1]), type: String(r[2] || ''), notnull: Number(r[3]) === 1,
          dflt: r[4] === null ? null : String(r[4]), pk: Number(r[5]), hidden: Number(r[6] || 0),
        }));
      } catch { /* view over a missing table */ }
      try {
        out.foreignKeys = this.all(`PRAGMA foreign_key_list(${q})`).rows.map(r => ({ from: String(r[3]), table: String(r[2]), to: r[4] === null ? null : String(r[4]), onUpdate: String(r[5]), onDelete: String(r[6]) }));
      } catch { /* none */ }
      out.indexes = this.objects.indexes.filter(i => i.table === name);
      out.triggers = this.objects.triggers.filter(t => t.table === name);
    } else if (type === 'index') {
      try { out.columns = this.all(`PRAGMA index_info(${U.quoteIdent(name)})`).rows.map(r => ({ cid: Number(r[1]), name: r[2] === null ? '(expression)' : String(r[2]) })); } catch { /* none */ }
    }
    return [out];
  }

  // ---------- copy and export ----------
  selection(sel, maxRows) {
    const s = this.source;
    const r0 = Math.max(0, sel.r0 | 0);
    const r1 = Math.min(this.viewCount - 1, sel.r1 | 0);
    const c0 = Math.max(0, sel.c0 | 0);
    const c1 = Math.min(s.columns.length - 1, sel.c1 | 0);
    const n = Math.max(0, r1 - r0 + 1);
    const take = Math.min(n, maxRows);
    const idx = [];
    for (let c = c0; c <= c1; c++) idx.push(c);
    return { columns: idx.map(i => s.columns[i].name), rows: take ? this.rawRows(r0, take, idx) : [], truncated: take < n };
  }

  copy(format, sel) {
    if (!this.source) return [];
    const max = this.opts.copyMaxRows || 100000;
    const whole = format === 'insert' ? { r0: sel.r0, r1: sel.r1, c0: 0, c1: this.source.columns.length - 1 } : sel;
    const d = this.selection(whole, max);
    const text = U.formatRows(d.columns, d.rows, format, { header: sel.header !== false, table: this.source.kind === 'table' ? this.source.name : 'query_result' });
    return [{ type: 'copyResult', format, text, rows: d.rows.length, truncated: d.truncated }];
  }

  exportText(format) {
    if (!this.source) return [];
    const max = this.opts.exportMaxRows || 1000000;
    const d = this.selection({ r0: 0, r1: this.viewCount - 1, c0: 0, c1: this.source.columns.length - 1 }, max);
    const text = U.formatRows(d.columns, d.rows, format === 'sql' ? 'insert' : format, { table: this.source.kind === 'table' ? this.source.name : 'query_result' }) + (format === 'sql' ? '\n' : '');
    return [{ type: 'exportResult', ok: true, format, text, rows: d.rows.length, truncated: d.truncated, bytes: Buffer.byteLength(text) }];
  }

  // ---------- reload ----------
  /** What the grid shows now, so a reloaded copy of the file can show the same thing. */
  state() {
    const s = this.source;
    if (!s) return null;
    return { kind: s.kind, name: s.name || null, sql: s.sql || null, sort: s.sort, filters: s.filters };
  }

  /** Show the same table or query as before a reload. Returns messages; the meta one has keep: true. */
  restore(st) {
    if (!st) return [];
    let out;
    if (st.kind === 'table' && st.name && this.findObject(st.name)) out = this.openTable(st.name);
    else if ((st.kind === 'query' || st.kind === 'list') && st.sql) out = this.runSql(st.sql);
    else return [];
    if (!this.source || out.some(m => m.type === 'sqlError' || m.type === 'error')) return out.filter(m => m.type !== 'sqlDone');
    const s = this.source;
    if (st.sort && s.canFilter && st.sort.col < s.columns.length) s.sort = st.sort;
    if (st.filters && s.canFilter) s.filters = st.filters;
    let refreshed;
    try { refreshed = this.refresh(true); } catch {
      s.filters = { global: '', columns: {} };
      refreshed = this.refresh(true);
    }
    return refreshed.map(m => (m.type === 'meta' ? { ...m, keep: true } : m));
  }

  // ---------- dispatch ----------
  /** msg was checked by protocol.validateWebviewMessage. Returns messages for the host. */
  handle(msg) {
    try {
      switch (msg.type) {
        case 'objects': return [this.objectsMessage()];
        case 'openTable': return this.openTable(msg.name);
        case 'runSql': return this.runSql(msg.sql);
        case 'getRows': return this.getRows(msg.reqId, msg.start, msg.count);
        case 'sort': return this.setSort(msg.col, msg.dir);
        case 'filter': return this.setFilters(msg.global, msg.columns);
        case 'cell': return this.cell(msg.row, msg.col);
        case 'count': return this.count(msg.name);
        case 'schema': return this.schema(msg.name);
        case 'copy': return this.copy(msg.format, msg.sel);
        case 'export': return this.exportText(msg.format);
        case 'resync': return [...(this.source ? [this.objectsMessage(), this.metaMessage(0)] : [this.objectsMessage()]), ...(this.pendingMessage ? [this.pendingMessage()] : [])];
        default: return this.handleEdit ? this.handleEdit(msg) : [];
      }
    } catch (e) {
      if (msg.type === 'export') return [{ type: 'exportResult', ok: false, error: U.friendlyOpenError(e) }];
      return [{ type: 'error', message: U.friendlyOpenError(e), transient: true }];
    }
  }
}

/** Open a database from its bytes, or throw an Error whose message is ready to show. */
function openSession(SQL, bytes, opts = {}) {
  let wal = { present: false };
  if (opts.wal && opts.wal.length) {
    const r = applyWal(bytes, opts.wal);
    wal = { present: true, applied: r.applied, commits: r.commits, pages: r.pages, reason: r.reason || null };
    if (r.applied) bytes = r.bytes;
  }
  const kind = U.sniff(bytes);
  if (kind === 'other') throw new Error(U.notSqliteMessage(bytes, opts.fileSize || bytes.length));
  try {
    const session = new Session(SQL, bytes, opts);
    session.wal = wal;
    return session;
  } catch (e) {
    throw new Error(U.friendlyOpenError(e));
  }
}

require('./editing').installEditing(Session);

module.exports = { Session, openSession, PAGE_MAX, LIST_MAX };
