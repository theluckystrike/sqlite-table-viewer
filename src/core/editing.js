'use strict';
// Editing mode for a Session. A database opens read-only. After "Enable editing" every change runs inside one
// open transaction, each change in its own SAVEPOINT, so Undo rolls back exactly the last change and the grid
// shows the staged state. Nothing reaches the file until save(): constraint checks, COMMIT in memory, export
// of the image, then writeback.safeWrite (backup, temp file, fsync, rename).

const U = require('./sqlutil');
const E = require('./edit');

const DELETE_MAX = 100000;
const DUP_MAX = 10000;
const DEFAULT_EDIT_LIMIT = 256 * 1024 * 1024;

function installEditing(Session) {
  const P = Session.prototype;

  /** Why the current grid cannot be edited, or '' when it can. */
  P.editableReason = function () {
    const s = this.source;
    if (!s) return 'Nothing is open.';
    if (s.kind !== 'table') return 'Query results are read-only. Open a table to edit it, or run INSERT, UPDATE or DELETE in the SQL box.';
    if (!s.isTable) return 'Views are read-only.';
    if (!s.key) return 'This table has no usable row key (a virtual or internal table, or a rowid hidden by columns named rowid, _rowid_ and oid with no primary key).';
    return '';
  };

  P.pendingMessage = function () {
    const e = this.edit;
    return {
      type: 'pending', editing: !!e,
      items: e ? e.pending.map(p => ({ id: p.id, label: p.label, sql: p.sql, committed: !!p.committed })) : [],
      canUndo: !!e && e.pending.length > 0 && !e.pending[e.pending.length - 1].committed,
      busy: e ? e.busy || '' : '',
    };
  };

  /** Start editing mode. opts: { foreignKeys: boolean, editLimitBytes }. The host has checked the file first. */
  P.enableEditing = function (opts = {}) {
    if (this.edit) return [this.pendingMessage()];
    const limit = opts.editLimitBytes || DEFAULT_EDIT_LIMIT;
    if (this.fileSize > limit) {
      return [{ type: 'editRefused', message: `Editing is limited to files up to ${Math.round(limit / 1048576)} MB (setting sqliteTableViewer.editMaxFileSizeMB), because the whole database and a second copy for the save must fit in memory. This file is ${(this.fileSize / 1048576).toFixed(0)} MB. It stays open read-only.` }];
    }
    if (this.wal && this.wal.applied) return [{ type: 'editRefused', message: 'This view includes transactions from the -wal file. Checkpoint the database first, then enable editing.' }];
    this.edit = { pending: [], seq: 0, foreignKeys: opts.foreignKeys !== false, busy: '' };
    this.applyEditPragmas();
    this.db.run('BEGIN');
    // keep: the grid stays where it is (scroll, widths, selection); only the editable flag changes.
    return [this.pendingMessage(), ...(this.source ? [{ ...this.metaMessage(0), keep: true }] : [])];
  };

  P.applyEditPragmas = function () {
    this.db.run('PRAGMA query_only = OFF');
    this.db.run(`PRAGMA foreign_keys = ${this.edit && this.edit.foreignKeys ? 'ON' : 'OFF'}`);
  };

  /** Leave editing mode. Refused while changes are pending. */
  P.disableEditing = function () {
    if (!this.edit) return [this.pendingMessage()];
    if (this.edit.pending.length) return [{ type: 'error', message: 'Save or discard the pending changes first.', transient: true }];
    try { this.db.run('ROLLBACK'); } catch { /* no transaction */ }
    this.edit = null;
    this.db.run('PRAGMA query_only = ON');
    return [this.pendingMessage(), ...(this.source ? [{ ...this.metaMessage(0), keep: true }] : [])];
  };

  /** Run fn inside a new savepoint. On success the change joins the pending list; on error it is rolled back. */
  P.stage = function (label, sqlText, fn, opts = {}) {
    const e = this.edit;
    if (!e) return { ok: false, message: 'Click "Enable editing" first.' };
    if (e.busy) return { ok: false, message: 'Wait until the import finishes.' };
    const id = ++e.seq;
    const sp = `zovo_edit_${id}`;
    this.db.run(`SAVEPOINT ${sp}`);
    let result;
    try {
      result = fn();
    } catch (err) {
      try { this.db.run(`ROLLBACK TO ${sp}`); this.db.run(`RELEASE ${sp}`); } catch { /* savepoint gone */ }
      return { ok: false, message: constraintMessage(err) };
    }
    e.pending.push({ id, sp, label, sql: sqlText, ddl: !!opts.ddl });
    return { ok: true, result };
  };

  /** Messages after a change: objects (counts, new tables), the grid, the pending list. */
  P.afterChange = function (ddl, extra = []) {
    this.objects = this.listObjects();
    const out = [this.objectsMessage()];
    const st = this.state();
    if (this.source && this.source.kind === 'table') {
      if (ddl || !this.findObject(this.source.name)) {
        const name = this.findObject(this.source.name) ? this.source.name : null;
        if (name) out.push(...this.restore(st));
        else {
          // The table is gone (DROP TABLE): show the first one left.
          const next = this.objects.tables.find(t => !t.system) || this.objects.tables[0];
          if (next) out.push(...this.openTable(next.name));
        }
      } else {
        try { out.push(...this.refresh(false, true)); } catch { out.push(...this.restore(st)); }
      }
    } else if (this.source && this.source.kind === 'query') {
      try { out.push(...this.refresh(false, true)); } catch { /* the query no longer runs */ }
    }
    out.push(...extra, this.pendingMessage());
    return out;
  };

  P.requireEditable = function (version) {
    if (!this.edit) return 'Click "Enable editing" first.';
    const why = this.editableReason();
    if (why) return why;
    if (version !== undefined && version !== this.version) return 'The view changed. Try again.';
    return '';
  };

  /** Row keys for rows [r0, r1] of the current view, as arrays of values. */
  P.keysFor = function (r0, count) {
    const s = this.source;
    const w = this.whereSql();
    const sql = `SELECT ${s.key.join(', ')} FROM ${s.from}${w.sql}${this.orderSql()} LIMIT ? OFFSET ?`;
    return this.all(sql, [...w.params, count, r0]).rows;
  };

  P.keyWhere = function (keys) {
    const s = this.source;
    if (s.key.length === 1) {
      return { sql: `${s.key[0]} IN (${keys.map(() => '?').join(', ')})`, params: keys.map(k => k[0]) };
    }
    const one = '(' + s.key.map(k => `${k} IS ?`).join(' AND ') + ')';
    return { sql: keys.map(() => one).join(' OR '), params: keys.flat() };
  };

  P.editCell = function (row, col, value, version) {
    const why = this.requireEditable(version);
    if (why) return [{ type: 'editError', message: why }];
    const c = this.source.columns[col];
    if (!c) return [];
    if (c.generated) return [{ type: 'editError', message: `${c.name} is a generated column. SQLite computes it.` }];
    let v = value;
    if (!(value instanceof Uint8Array)) {
      const r = E.toValue(value, c.type);
      if (!r.ok) return [{ type: 'editError', message: r.message }];
      v = r.value;
    }
    const key = this.keysFor(row, 1)[0];
    if (!key) return [{ type: 'editError', message: 'That row is no longer in view.' }];
    const kw = this.keyWhere([key]);
    const sql = `UPDATE ${this.source.from} SET ${U.quoteIdent(c.name)} = ? WHERE ${kw.sql}`;
    const params = [v, ...kw.params];
    const r = this.stage(`Edit ${this.source.name}.${c.name}`, E.inlineParams(sql, params) + ';', () => this.db.run(sql, params));
    if (!r.ok) return [{ type: 'editError', message: r.message }];
    return this.afterChange(false);
  };

  P.insertRow = function (version) {
    const why = this.requireEditable(version);
    if (why) return [{ type: 'editError', message: why }];
    const s = this.source;
    let cols = [];
    try {
      cols = this.all(`PRAGMA table_xinfo(${U.quoteIdent(s.name)})`).rows
        .map(r => ({ name: String(r[1]), type: String(r[2] || ''), notnull: Number(r[3]) === 1, dflt: r[4], hidden: Number(r[6] || 0) !== 0 }));
    } catch { cols = []; }
    const meta = new Map(s.columns.map(c => [c.name, c]));
    for (const c of cols) c.rowidAlias = !!(meta.get(c.name) || {}).rowidAlias;
    const nv = E.newRowValues(cols);
    // A NOT NULL foreign key column gets the first existing parent key instead of 0, so the new row is valid.
    try {
      for (const fk of this.all(`PRAGMA foreign_key_list(${U.quoteIdent(s.name)})`).rows) {
        const [, , parent, from, to] = fk;
        const i = nv.cols.indexOf(String(from));
        if (i < 0) continue;
        const v = this.one(`SELECT MIN(${to === null ? '_rowid_' : U.quoteIdent(String(to))}) FROM ${U.quoteIdent(String(parent))}`);
        if (v !== null && v !== undefined) nv.vals[i] = v;
      }
    } catch { /* no foreign keys */ }
    const sql = nv.cols.length
      ? `INSERT INTO ${s.from} (${nv.cols.map(U.quoteIdent).join(', ')}) VALUES (${nv.cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${s.from} DEFAULT VALUES`;
    const r = this.stage(`Insert a row into ${s.name}`, E.inlineParams(sql, nv.vals) + ';', () => this.db.run(sql, nv.vals));
    if (!r.ok) return [{ type: 'editError', message: r.message }];
    const out = this.afterChange(false);
    // Unsorted rowid tables list the new row last.
    out.push({ type: 'focusRow', row: Math.max(0, this.viewCount - 1) });
    return out;
  };

  P.duplicateRows = function (r0, r1, version) {
    const why = this.requireEditable(version);
    if (why) return [{ type: 'editError', message: why }];
    const s = this.source;
    const n = Math.min(DUP_MAX, Math.max(0, r1 - r0 + 1));
    const keys = this.keysFor(r0, n);
    if (!keys.length) return [{ type: 'editError', message: 'Select the rows to duplicate.' }];
    const copyCols = s.columns.filter(c => !c.generated && !c.rowidAlias).map(c => U.quoteIdent(c.name));
    const kw = this.keyWhere(keys);
    const sql = `INSERT INTO ${s.from} (${copyCols.join(', ')}) SELECT ${copyCols.join(', ')} FROM ${s.from} WHERE ${kw.sql}`;
    const r = this.stage(`Duplicate ${keys.length} row${keys.length === 1 ? '' : 's'} in ${s.name}`, E.inlineParams(sql, kw.params) + ';', () => this.db.run(sql, kw.params));
    if (!r.ok) return [{ type: 'editError', message: r.message + (/UNIQUE/i.test(r.message) ? ' A copy of a row with a unique value needs a different value first.' : '') }];
    const out = this.afterChange(false);
    out.push({ type: 'focusRow', row: Math.max(0, this.viewCount - 1) });
    return out;
  };

  P.deleteRows = function (r0, r1, version) {
    const why = this.requireEditable(version);
    if (why) return [{ type: 'editError', message: why }];
    const s = this.source;
    const want = Math.max(0, r1 - r0 + 1);
    if (want > DELETE_MAX) return [{ type: 'editError', message: `Delete at most ${DELETE_MAX.toLocaleString('en-US')} rows at a time here. For more, run a DELETE statement in the SQL box.` }];
    const keys = this.keysFor(r0, want);
    if (!keys.length) return [{ type: 'editError', message: 'Select the rows to delete.' }];
    const kw = this.keyWhere(keys);
    const sql = `DELETE FROM ${s.from} WHERE ${kw.sql}`;
    const shown = keys.length > 50 ? `DELETE FROM ${s.from} WHERE … /* ${keys.length} rows by key */;` : E.inlineParams(sql, kw.params) + ';';
    const r = this.stage(`Delete ${keys.length} row${keys.length === 1 ? '' : 's'} from ${s.name}`, shown, () => this.db.run(sql, kw.params));
    if (!r.ok) return [{ type: 'editError', message: r.message }];
    return this.afterChange(false);
  };

  /** A write statement from the SQL box, staged like any other change. */
  P.runWriteSql = function (sql, readCheck) {
    const w = E.checkWrite(sql);
    if (!w.ok) return [{ type: 'sqlError', message: w.message || readCheck.message }];
    const t0 = Date.now();
    const text = U.trimStatement(sql);
    let changed = 0;
    const r = this.stage(`SQL: ${text.replace(/\s+/g, ' ').slice(0, 70)}${text.length > 70 ? '…' : ''}`, text + ';', () => { this.db.run(text); changed = this.db.getRowsModified(); }, { ddl: w.ddl });
    if (!r.ok) return [{ type: 'sqlError', message: r.message + ' Nothing was staged.' }];
    return this.afterChange(w.ddl, [{ type: 'sqlDone', ms: Date.now() - t0, rows: w.ddl ? 0 : changed, write: true, ddl: w.ddl }]);
  };

  P.undo = function () {
    const e = this.edit;
    if (!e || !e.pending.length) return [this.pendingMessage()];
    const last = e.pending[e.pending.length - 1];
    if (last.committed) return [{ type: 'error', message: 'The last change is already in memory from a save that did not reach the disk. Save again, or close and reopen the file.', transient: true }];
    this.db.run(`ROLLBACK TO ${last.sp}`);
    this.db.run(`RELEASE ${last.sp}`);
    e.pending.pop();
    return this.afterChange(last.ddl, [{ type: 'flash', message: `Undid: ${last.label}` }]);
  };

  P.discard = function () {
    const e = this.edit;
    if (!e) return [this.pendingMessage()];
    if (e.pending.some(p => p.committed)) return [{ type: 'error', message: 'Some changes are already in memory from a save that did not reach the disk. Close and reopen the file to drop them.', transient: true }];
    const ddl = e.pending.some(p => p.ddl);
    try { this.db.run('ROLLBACK'); } catch { /* no transaction */ }
    e.pending = [];
    this.db.run('BEGIN');
    return this.afterChange(ddl, [{ type: 'flash', message: 'Discarded all pending changes.' }]);
  };

  /**
   * Check constraints and build the new file image. Returns { ok, bytes } or { ok: false, message }.
   * The pending list stays when anything fails. headerModes: original bytes 18-19 (2 = WAL mode) to put back.
   */
  P.buildImage = function (headerModes) {
    const e = this.edit;
    if (!e || !e.pending.length) return { ok: false, message: 'Nothing to save.' };
    if (e.busy) return { ok: false, message: 'Wait until the import finishes.' };
    const uncommitted = e.pending.some(p => !p.committed);
    if (uncommitted) {
      if (e.foreignKeys) {
        let bad = [];
        try { bad = this.all('PRAGMA foreign_key_check', [], 6).rows; } catch { bad = []; }
        if (bad.length) {
          const [tbl, rowid, parent] = bad[0];
          return { ok: false, code: 'constraint', message: `Not saved: ${bad.length >= 6 ? 'several rows' : `${bad.length} row${bad.length === 1 ? '' : 's'}`} break a foreign key (first: ${tbl} row ${rowid} points to a missing row in ${parent}). Nothing was written. Fix the row or undo the change.` };
        }
      }
      try { this.db.run('COMMIT'); } catch (err) {
        return { ok: false, code: 'constraint', message: `Not saved: ${constraintMessage(err)} Nothing was written, and your pending changes are kept.` };
      }
      for (const p of e.pending) p.committed = true;
    }
    let bytes;
    try {
      const check = String(this.one('PRAGMA quick_check'));
      if (check !== 'ok') throw new Error(`SQLite's quick_check reports: ${check}`);
      bytes = this.db.export();
    } catch (err) {
      this.reopenAfterExport();
      return { ok: false, code: 'image', message: `Not saved: ${U.friendlyOpenError(err)}` };
    }
    this.reopenAfterExport();
    if (headerModes && bytes.length >= 100 && headerModes[0] === 2 && headerModes[1] === 2) { bytes[18] = 2; bytes[19] = 2; }
    return { ok: true, bytes };
  };

  // sql.js export() closes and reopens the database, which resets the PRAGMAs and ends the transaction.
  P.reopenAfterExport = function () {
    this.applyEditPragmas();
    try { this.db.run('BEGIN'); } catch { /* already in one */ }
  };

  /** After the file was written: the pending list is empty and the size is the new one. */
  P.markSaved = function (size) {
    this.edit.pending = [];
    this.fileSize = size;
  };

  // ---------- Pro candidates: schema editing and find and replace ----------

  P.schemaOp = function (op) {
    if (!this.edit) return [{ type: 'editError', message: 'Click "Enable editing" first.' }];
    const t = U.quoteIdent(op.table);
    let sql;
    let label;
    if (op.op === 'addColumn') {
      sql = `ALTER TABLE ${t} ADD COLUMN ${U.quoteIdent(op.column)}${op.colType ? ' ' + op.colType.replace(/[^\w ()]/g, '') : ''}`;
      label = `Add column ${op.column} to ${op.table}`;
    } else if (op.op === 'renameColumn') {
      sql = `ALTER TABLE ${t} RENAME COLUMN ${U.quoteIdent(op.column)} TO ${U.quoteIdent(op.newName)}`;
      label = `Rename ${op.table}.${op.column} to ${op.newName}`;
    } else if (op.op === 'dropColumn') {
      sql = `ALTER TABLE ${t} DROP COLUMN ${U.quoteIdent(op.column)}`;
      label = `Drop column ${op.table}.${op.column}`;
    } else if (op.op === 'renameTable') {
      sql = `ALTER TABLE ${t} RENAME TO ${U.quoteIdent(op.newName)}`;
      label = `Rename table ${op.table} to ${op.newName}`;
    } else return [];
    const r = this.stage(label, sql + ';', () => this.db.run(sql), { ddl: true });
    if (!r.ok) return [{ type: 'editError', message: r.message }];
    if (op.op === 'renameTable' && this.source && this.source.name === op.table) this.source.name = op.newName;
    if (op.op === 'renameTable' && this.source && this.source.name === op.newName) this.source.from = U.quoteIdent(op.newName);
    return this.afterChange(true, [{ type: 'flash', message: `${label}: staged. Save writes it.` }]);
  };

  P.findReplace = function (o) {
    if (!this.edit) return [{ type: 'editError', message: 'Click "Enable editing" first.' }];
    const t = U.quoteIdent(o.table);
    const c = U.quoteIdent(o.column);
    let sql, params, where;
    if (o.whole) {
      where = o.matchCase ? `${c} = ?` : `${c} = ? COLLATE NOCASE`;
      sql = `UPDATE ${t} SET ${c} = ? WHERE ${where}`;
      params = [o.replace, o.find];
    } else if (o.matchCase) {
      sql = `UPDATE ${t} SET ${c} = replace(${c}, ?, ?) WHERE instr(${c}, ?) > 0`;
      params = [o.find, o.replace, o.find];
    } else {
      // replace() is case-sensitive; for a case-insensitive replace each match is found with instr on lower().
      sql = `UPDATE ${t} SET ${c} = zovo_ireplace(${c}, ?, ?) WHERE instr(lower(${c}), lower(?)) > 0`;
      params = [o.find, o.replace, o.find];
      this.ensureIReplace();
    }
    let changed = 0;
    const r = this.stage(`Replace "${o.find}" with "${o.replace}" in ${o.table}.${o.column}`, E.inlineParams(sql, params) + ';', () => { this.db.run(sql, params); changed = this.db.getRowsModified(); });
    if (!r.ok) return [{ type: 'editError', message: r.message }];
    return this.afterChange(false, [{ type: 'flash', message: `Replaced in ${changed.toLocaleString('en-US')} row${changed === 1 ? '' : 's'}. Staged; Save writes it.` }]);
  };

  P.ensureIReplace = function () {
    if (this.iReplace) return;
    this.db.create_function('zovo_ireplace', (s, find, rep) => {
      if (s === null || s === undefined || !find) return s;
      const str = String(s);
      const low = str.toLowerCase();
      const f = String(find).toLowerCase();
      let out = '', i = 0, j;
      while ((j = low.indexOf(f, i)) !== -1) { out += str.slice(i, j) + rep; i = j + f.length; }
      return out + str.slice(i);
    });
    this.iReplace = true;
  };

  /** Edit-mode messages; msg was checked by protocol.js or built by the host. */
  P.handleEdit = function (msg) {
    switch (msg.type) {
      case 'enableEditing': return this.enableEditing(msg.options);
      case 'disableEditing': return this.disableEditing();
      case 'editCell': return this.editCell(msg.row, msg.col, msg.value, msg.version);
      case 'insertRow': return this.insertRow(msg.version);
      case 'duplicateRows': return this.duplicateRows(msg.r0, msg.r1, msg.version);
      case 'deleteRows': return this.deleteRows(msg.r0, msg.r1, msg.version);
      case 'undo': return this.undo();
      case 'discard': return this.discard();
      case 'schemaOp': return this.schemaOp(msg.op);
      case 'findReplace': return this.findReplace(msg.op);
      case 'pendingList': return [this.pendingMessage()];
      default: return [];
    }
  };
}

/** A SQLite constraint or write error as one plain sentence. */
function constraintMessage(err) {
  const m = String((err && err.message) || err);
  if (/CHECK constraint failed: (.*)/i.test(m)) return `A CHECK constraint refused the change (${m.match(/CHECK constraint failed: (.*)/i)[1]}).`;
  if (/NOT NULL constraint failed: (.*)/i.test(m)) return `${m.match(/NOT NULL constraint failed: (.*)/i)[1]} cannot be NULL.`;
  if (/UNIQUE constraint failed: (.*)/i.test(m)) return `Another row already has this value in ${m.match(/UNIQUE constraint failed: (.*)/i)[1]} (UNIQUE).`;
  if (/FOREIGN KEY constraint failed/i.test(m)) return 'A foreign key refused the change: the row points to a missing parent row, or other rows still point to it.';
  if (/datatype mismatch/i.test(m)) return 'Datatype mismatch: this column only takes a whole number (INTEGER PRIMARY KEY or a STRICT table).';
  if (/cannot store/i.test(m)) return m + '.';
  return U.friendlyOpenError(err);
}

module.exports = { installEditing, constraintMessage, DELETE_MAX, DEFAULT_EDIT_LIMIT };
