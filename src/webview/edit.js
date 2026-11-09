'use strict';
// Editing mode in the webview: the edit bar, inline cell editing, the cell panel editor, the pending list and the
// CSV import panel. All text goes into the DOM through textContent. Every change is sent to the worker, which
// stages it; nothing here touches the file.
const U = require('./editui');

function installEdit(x) {
  const { S, el, vscode, fmtN } = x;
  S.edit = { canEdit: false, editing: false, items: [], canUndo: false, busy: '', proEnabled: false, showPending: false, refused: null, changedOnDisk: false, saveError: '', importing: null, preview: null };
  const E = S.edit;

  // ---------- toolbar button (read-only state) and the edit bar ----------
  const btnEnable = el('button', 'btn primary', 'Enable editing');
  btnEnable.title = 'The file opens read-only. Editing stages every change in memory. Nothing is written until you click Save, which makes a backup first.';
  btnEnable.hidden = true;
  btnEnable.addEventListener('click', () => { E.refused = null; renderBanner(); vscode.postMessage({ type: 'enableEditing' }); });
  const btnImport = el('button', 'btn', 'Import CSV');
  btnImport.title = 'Import a CSV or TSV file into a new or existing table (staged; Save writes it)';
  btnImport.hidden = true;
  btnImport.addEventListener('click', () => vscode.postMessage({ type: 'importCsv' }));
  x.toolbar.insertBefore(btnImport, x.toolbar.querySelector('.tabs'));
  x.toolbar.insertBefore(btnEnable, btnImport);

  const bar = el('div', 'editbar');
  bar.hidden = true;
  const state = el('span', 'estate');
  const btnAdd = el('button', 'btn', '+ Row');
  btnAdd.title = 'Insert a row (staged)';
  const btnDup = el('button', 'btn', 'Duplicate');
  btnDup.title = 'Duplicate the selected rows (staged)';
  const btnDel = el('button', 'btn', 'Delete rows');
  btnDel.title = 'Delete the selected rows (staged; Undo brings them back until you save)';
  const tools = el('select', 'sheet');
  tools.setAttribute('aria-label', 'Table tools');
  const btnUndo = el('button', 'btn', 'Undo');
  btnUndo.title = 'Undo the last staged change (Ctrl+Z or Cmd+Z in the grid)';
  const btnPending = el('button', 'btn', '0 pending');
  btnPending.title = 'Show the staged changes as SQL';
  const btnSave = el('button', 'btn primary', 'Save');
  btnSave.title = 'Write all staged changes to the file: checks, a backup copy, then an atomic replace (Ctrl+S or Cmd+S)';
  const btnStop = el('button', 'btn', 'Stop editing');
  btnStop.title = 'Back to read-only (only when nothing is pending)';
  const emsg = el('span', 'emsg');
  bar.append(state, btnAdd, btnDup, btnDel, tools, el('span', 'spacer'), emsg, btnUndo, btnPending, btnSave, btnStop);
  const pendingPanel = el('div', 'pendinglist');
  pendingPanel.hidden = true;
  x.app.insertBefore(bar, x.banners);
  x.app.insertBefore(pendingPanel, x.banners);
  const editBanner = el('div', 'editbanners');
  x.app.insertBefore(editBanner, x.banners);

  btnAdd.addEventListener('click', () => vscode.postMessage({ type: 'insertRow', version: S.version }));
  btnDup.addEventListener('click', () => { const r = selRows(); if (r) vscode.postMessage({ type: 'duplicateRows', r0: r[0], r1: r[1], version: S.version }); else x.flash('Select rows first (click the row numbers).'); });
  btnDel.addEventListener('click', deleteSelected);
  btnUndo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
  btnPending.addEventListener('click', () => { E.showPending = !E.showPending; renderPending(); });
  btnSave.addEventListener('click', save);
  btnStop.addEventListener('click', () => vscode.postMessage({ type: 'disableEditing' }));
  tools.addEventListener('change', () => {
    const v = tools.value;
    tools.value = '';
    if (v === 'findReplace') vscode.postMessage({ type: 'findReplace' });
    else if (v) vscode.postMessage({ type: 'schemaAction', action: v, col: S.focus ? S.focus.c : undefined });
  });
  function renderTools() {
    tools.textContent = '';
    const pro = E.proEnabled ? ' (Pro)' : '';
    for (const [v, label] of [['', 'Table tools…'], ['addColumn', 'Add column' + pro], ['renameColumn', 'Rename column' + pro], ['dropColumn', 'Drop column' + pro], ['renameTable', 'Rename table' + pro], ['findReplace', 'Find and replace in a column' + pro]]) {
      const o = el('option', null, label);
      o.value = v;
      tools.append(o);
    }
  }
  renderTools();

  function save() {
    if (!E.editing || !E.items.length) return;
    E.saveError = '';
    renderBanner();
    vscode.postMessage({ type: 'save' });
  }

  function selRows() {
    const sel = x.currentSel();
    if (sel) return [sel.r0, sel.r1];
    if (S.focus) return [S.focus.r, S.focus.r];
    return null;
  }

  function deleteSelected() {
    const r = selRows();
    if (!r) { x.flash('Select rows first (click the row numbers).'); return; }
    vscode.postMessage({ type: 'deleteRows', r0: r[0], r1: r[1], version: S.version });
  }

  const editableHere = () => E.editing && !(S.meta && S.meta.editable);

  function render() {
    btnEnable.hidden = !E.canEdit || E.editing;
    btnImport.hidden = !E.canEdit;
    bar.hidden = !E.editing;
    x.roBadge.textContent = E.editing ? 'EDITING' : 'READ-ONLY';
    x.roBadge.classList.toggle('editing', E.editing);
    x.roBadge.title = E.editing
      ? 'Changes are staged in memory. Save writes them (backup first, then an atomic replace).'
      : 'Opened read-only. Nothing is written until you click Enable editing and then Save.';
    const n = E.items.length;
    state.textContent = E.busy === 'import' ? 'Importing…' : n ? `${fmtN(n)} pending change${n === 1 ? '' : 's'}` : 'No pending changes';
    btnPending.textContent = E.showPending ? 'Hide SQL' : `Show SQL (${fmtN(n)})`;
    btnPending.disabled = !n;
    btnSave.disabled = !n || !!E.busy;
    btnUndo.disabled = !E.canUndo || !!E.busy;
    btnStop.disabled = !!n || !!E.busy;
    const why = S.meta && S.meta.editable;
    btnAdd.disabled = btnDup.disabled = btnDel.disabled = !!why || !!E.busy;
    emsg.textContent = why || '';
    emsg.className = 'emsg muted';
    renderPending();
    x.schedule();
  }

  function renderPending() {
    pendingPanel.hidden = !E.editing || !E.showPending || !E.items.length;
    if (pendingPanel.hidden) return;
    pendingPanel.textContent = '';
    const head = el('div', 'plhead');
    head.append(el('strong', null, `${fmtN(E.items.length)} staged change${E.items.length === 1 ? '' : 's'}`), el('span', 'muted', ' run inside one transaction when you click Save.'));
    const discard = el('button', 'link', 'Discard all');
    discard.addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
    head.append(discard);
    pendingPanel.append(head);
    E.items.forEach((it, i) => {
      const row = el('div', 'plitem');
      row.append(el('div', 'pllabel', `${i + 1}. ${it.label}${it.committed ? ' (in memory, not on disk yet)' : ''}`));
      row.append(el('pre', 'sqlpre', it.sql));
      pendingPanel.append(row);
    });
  }

  function renderBanner() {
    editBanner.textContent = '';
    const add = (text, cls, buttons = []) => {
      const b = el('div', 'banner ' + cls);
      b.append(el('span', null, text));
      for (const [label, fn] of buttons) { const l = el('button', 'link', label); l.addEventListener('click', fn); b.append(l); }
      editBanner.append(b);
    };
    if (E.refused) {
      const btns = E.refused.code === 'wal' ? [['Checkpoint and reload', () => vscode.postMessage({ type: 'checkpoint' })]] : [];
      btns.push(['Close', () => { E.refused = null; renderBanner(); }]);
      add(E.refused.message, 'error', btns);
    }
    if (E.changedOnDisk) {
      add('The file changed on disk while you were editing. Save will refuse to overwrite it. Discard your changes and reload to see the new version.', 'warn', [
        ['Discard and reload', () => { E.reloadAfterStop = true; vscode.postMessage({ type: 'discard' }); vscode.postMessage({ type: 'disableEditing' }); }],
      ]);
    }
    if (E.saveError) add(E.saveError, 'error', [['Close', () => { E.saveError = ''; renderBanner(); }]]);
  }

  // ---------- inline editor ----------
  let inline = null;
  function startInline(r, c, initialText) {
    if (!editableHere()) { if (E.editing && S.meta && S.meta.editable) x.flash(S.meta.editable); return false; }
    const col = S.columns[c];
    if (col && col.generated) { x.flash(`${col.name} is a generated column.`); return true; }
    const raw = x.cellValue(r, c);
    const k = U.inlineKind(raw);
    if (k === 'none') return false; // the row is still loading
    if (k !== 'inline') { x.openCell(); return true; }
    const cellEl = x.cellElement(r, c);
    if (!cellEl) return false;
    endInline(false);
    const wrapRect = x.gridWrap.getBoundingClientRect();
    const rect = cellEl.getBoundingClientRect();
    const input = el('input', 'inlineedit');
    input.value = initialText !== undefined ? initialText : U.editText(raw);
    input.style.left = (rect.left - wrapRect.left) + 'px';
    input.style.top = (rect.top - wrapRect.top) + 'px';
    input.style.width = Math.max(rect.width, 120) + 'px';
    input.style.height = rect.height + 'px';
    input.setAttribute('aria-label', `Edit ${col ? col.name : 'cell'}, row ${r + 1}`);
    inline = { input, r, c, before: raw };
    x.gridWrap.append(input);
    input.focus();
    if (initialText === undefined) input.select();
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); endInline(true); x.move(1, 0); }
      else if (ev.key === 'Tab') { ev.preventDefault(); endInline(true); x.move(0, ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); endInline(false); }
    });
    input.addEventListener('blur', () => endInline(true));
    return true;
  }

  function endInline(commit) {
    if (!inline) return;
    const it = inline;
    inline = null;
    it.input.remove();
    x.grid.focus();
    if (!commit) return;
    const text = it.input.value;
    if (!U.changed(it.before, text)) return;
    vscode.postMessage({ type: 'editCell', row: it.r, col: it.c, version: S.version, value: { t: 'auto', v: text } });
  }
  x.grid.addEventListener('scroll', () => endInline(true));

  // ---------- cell panel editor ----------
  function decorateCell(msg) {
    const panel = x.cellPanel;
    const v = msg.value;
    if (v.kind === 'blob') {
      const out = el('button', 'btn', 'Save BLOB to file…');
      out.addEventListener('click', () => vscode.postMessage({ type: 'blobToFile', row: msg.row, col: msg.col }));
      panel.append(el('div', 'k', 'File'), out);
    }
    if (!E.editing) return;
    if (S.meta && S.meta.editable) { panel.append(el('div', 'k', 'Edit'), el('div', 'muted', S.meta.editable)); return; }
    const col = S.columns[msg.col];
    if (col && col.generated) { panel.append(el('div', 'k', 'Edit'), el('div', 'muted', 'A generated column: SQLite computes it.')); return; }
    panel.append(el('div', 'k', 'Edit value'));
    const box = el('div', 'celledit');
    const type = el('select', 'sheet');
    type.setAttribute('aria-label', 'Value type');
    for (const [val, label] of U.TYPE_CHOICES) { const o = el('option', null, label); o.value = val; type.append(o); }
    type.value = U.defaultType(v);
    const ta = el('textarea', 'sqlinput');
    ta.rows = 6;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'New value');
    ta.value = U.panelText(v);
    if (v.kind === 'text' && v.cut) { ta.disabled = true; ta.value = 'This value is over 2 MB. Change it with an UPDATE statement in the SQL box.'; }
    const sync = () => { ta.disabled = type.value === 'null' || (v.kind === 'text' && v.cut); ta.placeholder = type.value === 'hex' ? 'Hex digits, two per byte, for example 89504e470d0a1a0a' : ''; };
    type.addEventListener('change', sync);
    sync();
    const apply = el('button', 'btn primary', 'Apply');
    apply.title = 'Stage this value (Save writes it)';
    apply.addEventListener('click', () => {
      vscode.postMessage({ type: 'editCell', row: msg.row, col: msg.col, version: S.version, value: { t: type.value, v: type.value === 'null' ? '' : ta.value } });
    });
    const load = el('button', 'btn', 'Load file into cell…');
    load.title = 'Store a file from disk in this cell as a BLOB (up to 64 MB)';
    load.addEventListener('click', () => vscode.postMessage({ type: 'blobFromFile', row: msg.row, col: msg.col, version: S.version }));
    const rowb = el('div', 'sqlrow');
    rowb.append(type, apply, load);
    box.append(ta, rowb);
    panel.append(box);
  }

  // ---------- CSV import ----------
  const imp = el('div', 'importpanel');
  imp.hidden = true;
  x.content.append(imp);

  function renderImport() {
    const p = E.preview;
    imp.hidden = !p && !E.importing;
    if (imp.hidden) return;
    imp.textContent = '';
    if (E.importing) {
      const pr = E.importing;
      imp.append(el('h3', null, `Importing ${p ? p.name : ''}…`));
      const barOut = el('div', 'progress');
      const barIn = el('div', 'progressin');
      barIn.style.width = U.percent(pr) + '%';
      barOut.append(barIn);
      imp.append(barOut, el('div', 'muted', U.progressText(pr)));
      const cancel = el('button', 'btn', 'Cancel');
      cancel.addEventListener('click', () => { cancel.disabled = true; vscode.postMessage({ type: 'importCancel' }); });
      imp.append(cancel);
      return;
    }
    const f = p.form;
    imp.append(el('h3', null, `Import ${p.name}`), el('div', 'muted', `${U.bytes(p.size)} · ${p.exact ? '' : 'about '}${fmtN(p.estRows)} rows · ${p.names.length} columns`));
    const opts = el('div', 'importopts');
    const sel = (label, choices, value, on) => {
      const w = el('label', 'iopt');
      w.append(el('span', null, label));
      const s = el('select', 'sheet');
      for (const [v, t] of choices) { const o = el('option', null, t); o.value = v; s.append(o); }
      s.value = value;
      s.addEventListener('change', () => on(s.value));
      w.append(s);
      opts.append(w);
      return s;
    };
    sel('Delimiter', U.DELIMS, p.delimiter, v => vscode.postMessage({ type: 'importPreview', options: { delimiter: v, encoding: p.encoding, header: p.header } }));
    sel('Encoding', U.ENCODINGS, p.encoding, v => vscode.postMessage({ type: 'importPreview', options: { delimiter: p.delimiter, encoding: v, header: p.header } }));
    sel('First row', [['yes', 'is the header'], ['no', 'is data']], p.header ? 'yes' : 'no', v => vscode.postMessage({ type: 'importPreview', options: { delimiter: p.delimiter, encoding: p.encoding, header: v === 'yes' } }));
    const tables = (S.objects ? S.objects.tables : []).filter(t => !t.system).map(t => t.name);
    sel('Into', [['new', 'a new table'], ...(tables.length ? [['existing', 'an existing table']] : [])], f.mode, v => {
      f.mode = v;
      if (v === 'existing') { f.table = tables.includes(f.table) ? f.table : (S.source && S.source.kind === 'table' && tables.includes(S.source.name) ? S.source.name : tables[0]); requestTargetColumns(); }
      else f.table = p.table;
      renderImport();
    });
    if (f.mode === 'new') {
      const w = el('label', 'iopt');
      w.append(el('span', null, 'Table name'));
      const t = el('input', 'finput tname');
      t.value = f.table;
      t.addEventListener('input', () => { f.table = t.value; });
      w.append(t);
      opts.append(w);
    } else {
      sel('Table', tables.map(n => [n, n]), f.table, v => { f.table = v; requestTargetColumns(); renderImport(); });
    }
    imp.append(opts);

    // Column mapping
    const t = el('table', 'fields maptable');
    const hr = el('tr');
    for (const h of ['CSV column', 'Import', f.mode === 'new' ? 'Column name' : 'Into column', f.mode === 'new' ? 'Type' : '', 'Transform' + (E.proEnabled ? ' (Pro)' : ''), 'First values']) hr.append(el('th', null, h));
    t.append(hr);
    p.names.forEach((name, i) => {
      const m = f.columns[i];
      const tr = el('tr');
      tr.append(el('td', 'fname', name));
      const inc = el('input');
      inc.type = 'checkbox';
      inc.checked = m.include;
      inc.setAttribute('aria-label', `Import ${name}`);
      inc.addEventListener('change', () => { m.include = inc.checked; });
      const td1 = el('td'); td1.append(inc); tr.append(td1);
      const td2 = el('td');
      if (f.mode === 'new') {
        const n = el('input', 'finput');
        n.value = m.name;
        n.addEventListener('input', () => { m.name = n.value; });
        td2.append(n);
      } else {
        const s = el('select', 'sheet');
        const none = el('option', null, '(skip)'); none.value = ''; s.append(none);
        for (const c of f.targetColumns || []) { const o = el('option', null, c); o.value = c; s.append(o); }
        s.value = m.target || '';
        s.addEventListener('change', () => { m.target = s.value; });
        td2.append(s);
      }
      tr.append(td2);
      const td3 = el('td');
      if (f.mode === 'new') {
        const s = el('select', 'sheet');
        for (const ty of ['INTEGER', 'REAL', 'TEXT', 'NUMERIC', 'BLOB', '']) { const o = el('option', null, ty || '(none)'); o.value = ty; s.append(o); }
        s.value = m.type;
        s.addEventListener('change', () => { m.type = s.value; });
        td3.append(s);
      }
      tr.append(td3);
      const td4 = el('td');
      const tf = el('select', 'sheet');
      for (const [v, label] of U.TRANSFORMS) { const o = el('option', null, label); o.value = v; tf.append(o); }
      tf.value = m.transform;
      tf.addEventListener('change', () => { m.transform = tf.value; });
      td4.append(tf);
      tr.append(td4);
      tr.append(el('td', 'muted', p.rows.slice(0, 3).map(r => r[i] === undefined ? '' : String(r[i]).slice(0, 30)).join(' · ')));
      t.append(tr);
    });
    imp.append(t);

    // Preview grid (first 20 rows)
    imp.append(el('div', 'k', `Preview (first ${Math.min(20, p.rows.length)} of ${fmtN(p.rows.length)} sampled rows)`));
    const pv = el('table', 'fields previewtable');
    const ph = el('tr');
    p.names.forEach(n => ph.append(el('th', null, n)));
    pv.append(ph);
    for (const r of p.rows.slice(0, 20)) {
      const tr = el('tr');
      p.names.forEach((_, i) => tr.append(el('td', null, r[i] === undefined ? '' : String(r[i]).slice(0, 80))));
      pv.append(tr);
    }
    const wrap = el('div', 'previewwrap');
    wrap.append(pv);
    imp.append(wrap);

    const actions = el('div', 'sqlrow');
    const go = el('button', 'btn primary', 'Import');
    go.addEventListener('click', () => {
      const r = U.importOptions(p, f);
      if (!r.ok) { x.flash(r.message); return; }
      vscode.postMessage({ type: 'importRun', options: r.options });
    });
    const cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', () => { E.preview = null; renderImport(); });
    actions.append(go, cancel, el('span', 'muted', 'The import is one staged change: Undo removes it, and Save writes it.'));
    imp.append(actions);
  }

  function requestTargetColumns() {
    const f = E.preview && E.preview.form;
    if (!f || f.mode !== 'existing' || !f.table) return;
    S.importSchemaFor = f.table;
    vscode.postMessage({ type: 'schema', name: f.table });
  }

  // ---------- keys ----------
  /** Grid keydown. True when handled. */
  function onKeydown(e) {
    if (!E.editing) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (E.canUndo) vscode.postMessage({ type: 'undo' }); return true; }
    if (!S.focus) return false;
    if (e.key === 'F2' || (e.key === 'Enter' && !mod)) { e.preventDefault(); return startInline(S.focus.r, S.focus.c) || false; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!editableHere()) return false;
      e.preventDefault();
      const sel = x.currentSel();
      if (sel && sel.c0 === 0 && sel.c1 === S.columns.length - 1 && S.columns.length > 1) deleteSelected();
      else if (sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1)) x.flash('Select one cell to set it to NULL, or whole rows (row numbers) to delete them.');
      else vscode.postMessage({ type: 'editCell', row: S.focus.r, col: S.focus.c, version: S.version, value: { t: 'null', v: '' } });
      return true;
    }
    // Typing a character starts editing with that character.
    if (e.key.length === 1 && !mod && !e.altKey && e.key !== ' ' && editableHere()) {
      e.preventDefault();
      return startInline(S.focus.r, S.focus.c, e.key) || false;
    }
    return false;
  }
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (E.editing) save(); }
  });

  function onDblClick(hit) {
    if (!E.editing || hit.gutter) return false;
    return startInline(hit.r, hit.c);
  }

  // ---------- messages ----------
  function onMessage(msg) {
    switch (msg.type) {
      case 'init':
        E.canEdit = !!msg.canEdit;
        E.proEnabled = !!msg.proEnabled;
        renderTools();
        render();
        return false;
      case 'pending': {
        const was = E.editing;
        E.editing = !!msg.editing;
        E.items = msg.items || [];
        E.canUndo = !!msg.canUndo;
        E.busy = msg.busy || '';
        if (E.editing && !was) { E.refused = null; x.flash('Editing is on. Changes are staged until you click Save.'); x.updateStatus(); }
        if (!E.editing && was) { E.changedOnDisk = false; E.saveError = ''; if (E.reloadAfterStop) { E.reloadAfterStop = false; vscode.postMessage({ type: 'reload' }); } }
        render();
        renderBanner();
        return true;
      }
      case 'editRefused':
        E.refused = { message: msg.message, code: msg.code || '' };
        renderBanner();
        return true;
      case 'editError':
        x.flash(msg.message);
        E.lastError = msg.message;
        emsg.textContent = msg.message;
        emsg.className = 'emsg err';
        return true;
      case 'flash':
        x.flash(msg.message);
        return true;
      case 'focusRow':
        S.anchor = S.focus = { r: msg.row, c: S.focus ? S.focus.c : 0 };
        x.ensureVisible(msg.row);
        x.schedule();
        x.updateStatus();
        return true;
      case 'saving':
        x.flash('Saving…', true);
        return true;
      case 'saved':
        E.saveError = '';
        renderBanner();
        x.flash(`Saved ${fmtN(msg.changes)} change${msg.changes === 1 ? '' : 's'} in ${fmtN(msg.ms)} ms. Backup: ${U.baseName(msg.backup)}`);
        return true;
      case 'saveFailed':
        E.saveError = msg.message;
        if (msg.code === 'changed') E.changedOnDisk = true;
        renderBanner();
        x.flash('Not saved.');
        return true;
      case 'fileChanged':
        if (!msg.editing) return false;
        E.changedOnDisk = true;
        renderBanner();
        return true;
      case 'reloadFailed':
        if (!msg.editing) return false;
        x.flash(msg.message);
        return true;
      case 'importPreview': {
        const keep = E.preview && E.preview.file === msg.file ? E.preview.form : null;
        E.preview = msg;
        E.preview.form = U.importForm(msg, keep);
        if (E.preview.form.mode === 'existing') requestTargetColumns();
        renderImport();
        return true;
      }
      case 'importProgress':
        E.importing = msg;
        if (E.busy !== 'import') { E.busy = 'import'; render(); }
        renderImport();
        return true;
      case 'importDone':
        E.importing = null;
        E.busy = '';
        render();
        if (msg.ok) { E.preview = null; x.flash(`Imported ${fmtN(msg.rows)} rows into ${msg.table}. Staged; Save writes them.`); }
        else x.flash(msg.message);
        renderImport();
        return true;
      case 'schema':
        if (S.importSchemaFor && msg.name === S.importSchemaFor && E.preview) {
          S.importSchemaFor = null;
          const f = E.preview.form;
          f.targetColumns = msg.columns.filter(c => !c.hidden).map(c => c.name);
          U.autoMap(E.preview, f);
          renderImport();
          return S.tab !== 'schema';
        }
        return false;
      case 'meta':
        S.meta = msg;
        render();
        return false;
      default:
        return false;
    }
  }

  return { onMessage, onKeydown, onDblClick, decorateCell, render, endInline };
}

module.exports = { installEdit };
