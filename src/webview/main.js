'use strict';
/* global acquireVsCodeApi */
// SQLite Table Viewer webview. All database content goes into the DOM through textContent only
// (images use a data: URL built on the host from bytes it checked). The grid comes from Table Viewer.
const M = require('./math');
const C = require('./cells');

const vscode = acquireVsCodeApi();
const ROW_H = 24;
const PAGE = 200;
let HEAD_H = 52;
let GUTTER_W = 64;
const NUMERIC = new Set(['int', 'float', 'decimal']);

const S = {
  fileName: document.getElementById('app').dataset.title || '',
  objects: null, source: null, columns: [], widths: [], autoSized: false,
  rowCount: 0, version: -1, sort: null, filters: { global: '', columns: {} }, canFilter: true,
  cache: new Map(), pending: new Map(), reqId: 1, anchor: null, focus: null, dragging: false,
  tab: 'data', error: '', warnings: [], history: [], cellOpen: false, schema: null, timing: '',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
const fmtN = n => Number(n).toLocaleString('en-US');

// ---------- layout ----------
const app = document.getElementById('app');
const toolbar = el('div', 'toolbar');
const title = el('span', 'title', S.fileName);
const roBadge = el('span', 'fmt', 'READ-ONLY');
roBadge.title = 'The database is loaded into memory and never written back. Writes are refused.';
const stats = el('span', 'stats');
const spacer = el('span', 'spacer');
const tabs = el('div', 'tabs');
const tabBtns = {};
for (const [id, label] of [['data', 'Data'], ['schema', 'Schema'], ['sql', 'SQL']]) {
  const b = el('button', 'tab', label);
  b.addEventListener('click', () => setTab(id));
  tabBtns[id] = b;
  tabs.append(b);
}
const search = el('input', 'search');
search.type = 'search';
search.placeholder = 'Search all columns';
search.setAttribute('aria-label', 'Search all columns');
const btnCsv = el('button', 'btn', 'Copy CSV');
btnCsv.title = 'Copy the selection as CSV with a header row (no selection: the whole view)';
const btnJson = el('button', 'btn', 'Copy JSON');
btnJson.title = 'Copy the selection as a JSON array of objects';
const btnInsert = el('button', 'btn', 'Copy INSERT');
btnInsert.title = 'Copy the selected rows (all columns) as INSERT statements';
const btnExport = el('button', 'btn', 'Export');
btnExport.title = 'Save every row in view (filtered and sorted) as CSV or JSON';
toolbar.append(title, roBadge, stats, spacer, tabs, search, btnCsv, btnJson, btnInsert, btnExport);

const banners = el('div', 'banners');
const main = el('div', 'main');
const side = el('div', 'side');
const content = el('div', 'content');
main.append(side, content);

// SQL bar
const sqlBar = el('div', 'sqlbar');
sqlBar.hidden = true;
const sqlInput = el('textarea', 'sqlinput');
sqlInput.spellcheck = false;
sqlInput.rows = 4;
sqlInput.placeholder = 'SELECT * FROM table WHERE ...   (Ctrl+Enter or Cmd+Enter runs it. Read-only: SELECT, WITH, VALUES, EXPLAIN and reading PRAGMAs.)';
sqlInput.setAttribute('aria-label', 'SQL statement');
const sqlRow = el('div', 'sqlrow');
const sqlRun = el('button', 'btn primary', 'Run');
const sqlHist = el('select', 'sheet');
sqlHist.setAttribute('aria-label', 'Query history');
const sqlMsg = el('span', 'sqlmsg');
sqlRow.append(sqlRun, sqlHist, sqlMsg);
sqlBar.append(sqlInput, sqlRow);

const schemaPanel = el('div', 'schema');
schemaPanel.hidden = true;

const gridWrap = el('div', 'gridwrap');
const grid = el('div', 'grid');
grid.tabIndex = 0;
grid.setAttribute('role', 'grid');
const sizer = el('div', 'sizer');
const stage = el('div', 'stage');
const head = el('div', 'head');
const filterRow = el('div', 'filters');
const body = el('div', 'body');
stage.append(head, filterRow, body);
sizer.append(stage);
grid.append(sizer);
const cellPanel = el('div', 'cellpanel');
cellPanel.hidden = true;
gridWrap.append(grid, cellPanel);
const empty = el('div', 'empty');
empty.hidden = true;
content.append(sqlBar, schemaPanel, gridWrap, empty);

const status = el('div', 'status');
const statusLeft = el('span', 'left');
const statusMid = el('span', 'mid');
const statusRight = el('span', 'right');
status.append(statusLeft, statusMid, statusRight);
app.append(toolbar, banners, main, status);

// ---------- tabs ----------
function setTab(id) {
  S.tab = id;
  for (const k of Object.keys(tabBtns)) tabBtns[k].classList.toggle('on', k === id);
  sqlBar.hidden = id !== 'sql';
  schemaPanel.hidden = id !== 'schema';
  gridWrap.hidden = id === 'schema' || !S.columns.length;
  if (id === 'schema') requestSchema();
  if (id === 'sql') sqlInput.focus();
  layout();
}

// ---------- sidebar ----------
function renderSide() {
  side.textContent = '';
  const o = S.objects;
  if (!o) return;
  const groups = [['Tables', o.tables, 'table'], ['Views', o.views, 'view'], ['Indexes', o.indexes, 'index'], ['Triggers', o.triggers, 'trigger']];
  for (const [label, items, kind] of groups) {
    const sec = el('div', 'group');
    const h = el('div', 'ghead', `${label} (${items.length})`);
    sec.append(h);
    if (!items.length) sec.append(el('div', 'gnone', 'none'));
    for (const it of items) {
      const row = el('div', 'item');
      row.dataset.name = it.name;
      const nm = el('span', 'iname', it.name);
      row.append(nm);
      if (kind === 'table' || kind === 'view') {
        const active = S.source && S.source.kind === 'table' && S.source.name === it.name;
        row.classList.toggle('active', !!active);
        if (it.rows === null || it.rows === undefined || it.estimate) {
          const cnt = el('button', 'count', it.estimate ? `~${C.shortCount(it.rows)}` : 'count');
          cnt.title = it.estimate ? 'Estimate from sqlite_stat1. Click to count exactly.' : 'Count the rows';
          cnt.addEventListener('click', e => { e.stopPropagation(); cnt.textContent = '…'; vscode.postMessage({ type: 'count', name: it.name }); });
          row.append(cnt);
        } else row.append(el('span', 'rows', C.shortCount(it.rows)));
        row.title = `${it.name}\n${kind}${it.rows !== null && it.rows !== undefined ? ` · ${fmtN(it.rows)} rows` : ''}${it.withoutRowid ? ' · WITHOUT ROWID' : ''}`;
        row.addEventListener('click', () => {
          if (S.tab === 'sql') setTab('data');
          S.schemaName = it.name;
          vscode.postMessage({ type: 'openTable', name: it.name });
          if (S.tab === 'schema') requestSchema();
        });
      } else {
        row.append(el('span', 'rows', it.table));
        row.title = `${it.name} on ${it.table}\nClick to see its SQL`;
        row.addEventListener('click', () => { S.schemaName = it.name; setTab('schema'); });
      }
      sec.append(row);
    }
    side.append(sec);
  }
  const info = o.info || {};
  const foot = el('div', 'sidefoot');
  foot.textContent = [M.formatBytes(info.fileSize), info.pageSize ? `page ${fmtN(info.pageSize)} B` : '', info.encoding || '', info.sqliteVersion ? `SQLite ${info.sqliteVersion}` : ''].filter(Boolean).join(' · ');
  side.append(foot);
}

// ---------- schema ----------
function requestSchema() {
  const name = S.schemaName || (S.source && S.source.kind === 'table' ? S.source.name : null) || (S.objects && S.objects.tables[0] && S.objects.tables[0].name);
  if (!name) { schemaPanel.textContent = 'This database has no tables.'; return; }
  schemaPanel.textContent = 'Loading…';
  vscode.postMessage({ type: 'schema', name });
}

function renderSchema(s) {
  schemaPanel.textContent = '';
  schemaPanel.append(el('h3', null, `${s.objectType} ${s.name}` + (s.table && s.table !== s.name ? ` on ${s.table}` : '')));
  if (s.columns.length) {
    const t = el('table', 'fields');
    const hr = el('tr');
    const heads = s.objectType === 'index' ? ['#', 'Column'] : ['#', 'Column', 'Type', 'PK', 'Not null', 'Default', 'References'];
    heads.forEach(h => hr.append(el('th', null, h)));
    t.append(hr);
    for (const c of s.columns) {
      const tr = el('tr');
      if (s.objectType === 'index') { tr.append(el('td', 'num', c.cid), el('td', 'fname', c.name)); t.append(tr); continue; }
      const fk = s.foreignKeys.filter(f => f.from === c.name).map(f => `${f.table}(${f.to || 'rowid'})` + (f.onDelete !== 'NO ACTION' ? ` on delete ${f.onDelete.toLowerCase()}` : '')).join(', ');
      tr.append(el('td', 'num', c.cid), el('td', 'fname', c.name + (c.hidden === 2 || c.hidden === 3 ? ' (generated)' : '')), el('td', null, c.type), el('td', null, c.pk ? (c.pk > 1 ? `yes (${c.pk})` : 'yes') : ''),
        el('td', null, c.notnull ? 'yes' : ''), el('td', null, c.dflt === null ? '' : c.dflt), el('td', null, fk));
      t.append(tr);
    }
    schemaPanel.append(t);
  }
  schemaPanel.append(el('div', 'k', 'CREATE statement'));
  schemaPanel.append(el('pre', 'sqlpre', s.sql || '(none: internal object)'));
  for (const [label, list] of [['Indexes', s.indexes], ['Triggers', s.triggers]]) {
    if (!list || !list.length) continue;
    schemaPanel.append(el('div', 'k', label));
    for (const i of list) schemaPanel.append(el('pre', 'sqlpre', i.sql || `${i.name} (created by a UNIQUE or PRIMARY KEY constraint)`));
  }
}

// ---------- header ----------
function totalWidth() { return GUTTER_W + S.widths.reduce((a, b) => a + b, 0); }

function buildHeader() {
  head.textContent = '';
  filterRow.textContent = '';
  filterRow.hidden = !S.canFilter;
  HEAD_H = S.canFilter ? 52 : 28;
  const corner = el('div', 'cell gutter corner', '#');
  corner.title = 'Select all';
  corner.addEventListener('mousedown', e => { e.preventDefault(); selectAll(); });
  head.append(corner);
  filterRow.append(el('div', 'cell gutter'));
  S.columns.forEach((col, c) => {
    const h = el('div', 'cell hcell');
    h.style.width = S.widths[c] + 'px';
    h.dataset.col = String(c);
    const name = el('span', 'hname', col.name);
    const type = el('span', 'htype t-' + col.type, (col.declared || col.type) + (col.pk ? ' · PK' : ''));
    type.hidden = !col.declared && col.type === 'any' && !col.pk;
    const arrow = el('span', 'sort');
    if (S.sort && S.sort.col === c) arrow.textContent = S.sort.dir === 'asc' ? '▲' : '▼';
    h.title = `${col.name}\n${col.declared || 'no declared type'}${col.pk ? '\nprimary key' : ''}${S.canFilter ? '\nClick to sort' : ''}`;
    const grip = el('span', 'grip');
    grip.addEventListener('mousedown', e => startResize(e, c));
    h.append(name, type, arrow, grip);
    h.addEventListener('click', e => {
      if (e.target === grip || !S.canFilter) return;
      const next = M.nextSort(S.sort, c);
      flash('Sorting…', true);
      vscode.postMessage(next ? { type: 'sort', col: c, dir: next.dir } : { type: 'sort', col: null, dir: null });
    });
    head.append(h);
    const fcell = el('div', 'cell fcell');
    fcell.style.width = S.widths[c] + 'px';
    const inp = el('input', 'finput');
    inp.placeholder = NUMERIC.has(col.type) ? '>10, 5..9, =3' : 'contains';
    inp.title = 'Filter: text (contains), =exact, !not, >10, >=10, <5, !=3, 5..9, empty, !empty. Values are bound as SQL parameters.';
    inp.setAttribute('aria-label', `Filter ${col.name}`);
    inp.value = S.filters.columns[c] || '';
    inp.addEventListener('input', () => {
      if (inp.value.trim()) S.filters.columns[c] = inp.value; else delete S.filters.columns[c];
      sendFilters();
    });
    fcell.append(inp);
    filterRow.append(fcell);
  });
  const w = totalWidth();
  head.style.width = w + 'px';
  filterRow.style.width = w + 'px';
}

let resize = null;
function startResize(e, c) { e.preventDefault(); e.stopPropagation(); resize = { c, x: e.clientX, w: S.widths[c] }; }
window.addEventListener('mousemove', e => {
  if (resize) { S.widths[resize.c] = Math.max(40, resize.w + e.clientX - resize.x); applyWidths(); return; }
  if (S.dragging) { const hit = cellAt(e.clientX, e.clientY); if (hit) { S.focus = hit; render(); updateStatus(); } }
});
window.addEventListener('mouseup', () => { resize = null; S.dragging = false; });

function applyWidths() {
  const hs = head.querySelectorAll('.hcell');
  const fs = filterRow.querySelectorAll('.fcell');
  S.widths.forEach((w, c) => { if (hs[c]) hs[c].style.width = w + 'px'; if (fs[c]) fs[c].style.width = w + 'px'; });
  const tw = totalWidth();
  head.style.width = tw + 'px';
  filterRow.style.width = tw + 'px';
  rowPool.length = 0;
  body.textContent = '';
  layout();
}

// ---------- filters ----------
let filterTimer = null;
function sendFilters() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => vscode.postMessage({ type: 'filter', global: S.filters.global, columns: S.filters.columns }), 250);
}
search.addEventListener('input', () => { if (!S.canFilter) return; S.filters.global = search.value; sendFilters(); });

// ---------- body ----------
const rowPool = [];
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

function layout() {
  const bodyH = Math.min(S.rowCount * ROW_H, M.MAX_BODY_PX);
  sizer.style.height = (HEAD_H + bodyH) + 'px';
  const w = totalWidth();
  sizer.style.width = w + 'px';
  stage.style.width = w + 'px';
  render();
}

function viewportBodyH() { return Math.max(0, grid.clientHeight - HEAD_H); }

function visibleRange() {
  const vh = viewportBodyH();
  const { first, shift } = M.scrollToRow(grid.scrollTop, S.rowCount, ROW_H, vh);
  const count = Math.ceil((vh + shift) / ROW_H) + 1;
  return { first, last: Math.min(S.rowCount - 1, first + count - 1), shift };
}

function makeRowEl() {
  const r = el('div', 'row');
  const g = el('div', 'cell gutter');
  const sp = el('div', 'colspacer');
  r.append(g, sp);
  r._g = g; r._spacer = sp; r._cells = [];
  return r;
}

function syncRowCells(r, c0, c1) {
  const want = Math.max(0, c1 - c0 + 1);
  while (r._cells.length < want) { const d = el('div', 'cell'); r.append(d); r._cells.push(d); }
  while (r._cells.length > want) r._cells.pop().remove();
}

function render() {
  stage.style.height = Math.min(grid.clientHeight, HEAD_H + Math.min(S.rowCount * ROW_H, M.MAX_BODY_PX)) + 'px';
  if (!S.columns.length) { body.textContent = ''; return; }
  const { first, last, shift } = visibleRange();
  const n = Math.max(0, last - first + 1);
  const lefts = M.columnLefts(S.widths);
  const { c0, c1 } = M.visibleColumns(lefts, S.widths, grid.scrollLeft, grid.clientWidth, GUTTER_W);
  while (rowPool.length < n) { const r = makeRowEl(); rowPool.push(r); body.append(r); }
  body.style.transform = `translateY(${-shift}px)`;
  const sel = currentSel();
  const missing = [];
  for (let i = 0; i < rowPool.length; i++) {
    const r = rowPool[i];
    if (i >= n) { r.hidden = true; continue; }
    r.hidden = false;
    const vr = first + i;
    r._vr = vr;
    const page = S.cache.get(Math.floor(vr / PAGE));
    const row = page ? page[vr % PAGE] : null;
    r._g.textContent = fmtN(vr + 1);
    r._g.classList.toggle('selrow', !!sel && vr >= sel.r0 && vr <= sel.r1);
    syncRowCells(r, c0, c1);
    r._spacer.style.width = (c1 >= c0 ? lefts[c0] : 0) + 'px';
    for (let j = 0; j < r._cells.length; j++) {
      const c = c0 + j;
      const cell = r._cells[j];
      cell._c = c;
      cell.style.width = S.widths[c] + 'px';
      if (!row) { cell.textContent = ''; cell.className = 'cell pending'; }
      else {
        const d = C.display(row.cells[c]);
        cell.textContent = d.text;
        cell.className = 'cell ' + d.cls;
      }
      if (M.inSel(sel, vr, c)) cell.classList.add('sel');
      if (S.focus && S.focus.r === vr && S.focus.c === c) cell.classList.add('focus');
    }
    if (!row) missing.push(vr);
  }
  if (missing.length) request(missing[0], missing[missing.length - 1]);
}

function request(first, last) {
  for (const p of M.pagesFor(first, last, PAGE)) {
    if (S.cache.has(p)) continue;
    let already = false;
    for (const q of S.pending.values()) if (q.page === p && q.version === S.version) already = true;
    if (already) continue;
    const reqId = S.reqId++;
    S.pending.set(reqId, { page: p, version: S.version });
    vscode.postMessage({ type: 'getRows', reqId, start: p * PAGE, count: PAGE });
  }
}

grid.addEventListener('scroll', schedule);
window.addEventListener('resize', schedule);

// ---------- selection ----------
function currentSel() { return S.anchor && S.focus ? M.normSel(S.anchor, S.focus) : null; }

function cellAt(x, y) {
  const hitEl = document.elementFromPoint(x, y);
  if (!hitEl) return null;
  const cell = hitEl.closest('.row > .cell');
  if (!cell) return null;
  const r = cell.parentElement._vr;
  if (r === undefined) return null;
  if (cell.classList.contains('gutter')) return { r, c: 0, gutter: true };
  return { r, c: cell._c === undefined ? 0 : cell._c, gutter: false };
}

body.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const hit = cellAt(e.clientX, e.clientY);
  if (!hit) return;
  e.preventDefault();
  grid.focus();
  if (hit.gutter) {
    const lastC = S.columns.length - 1;
    if (e.shiftKey && S.anchor) { S.focus = { r: hit.r, c: lastC }; S.anchor = { r: S.anchor.r, c: 0 }; }
    else { S.anchor = { r: hit.r, c: 0 }; S.focus = { r: hit.r, c: lastC }; }
  } else if (e.shiftKey && S.anchor) S.focus = { r: hit.r, c: hit.c };
  else { S.anchor = { r: hit.r, c: hit.c }; S.focus = { r: hit.r, c: hit.c }; }
  S.dragging = !hit.gutter;
  render();
  updateStatus();
  if (S.cellOpen && !hit.gutter) requestCell();
});
body.addEventListener('dblclick', e => {
  const hit = cellAt(e.clientX, e.clientY);
  if (!hit || hit.gutter) return;
  S.focus = S.anchor = { r: hit.r, c: hit.c };
  openCell();
});

function selectAll() {
  if (!S.rowCount || !S.columns.length) return;
  S.anchor = { r: 0, c: 0 };
  S.focus = { r: S.rowCount - 1, c: S.columns.length - 1 };
  render();
  updateStatus();
}

function ensureVisible(r) {
  const { first, last } = visibleRange();
  const vh = viewportBodyH();
  if (r < first + 1) grid.scrollTop = M.rowToScroll(r, S.rowCount, ROW_H, vh);
  else if (r > last - 1) grid.scrollTop = M.rowToScroll(Math.max(0, r - Math.floor(vh / ROW_H) + 1), S.rowCount, ROW_H, vh);
}
function ensureColVisible(c) {
  const lefts = M.columnLefts(S.widths);
  const viewW = grid.clientWidth - GUTTER_W;
  if (lefts[c] < grid.scrollLeft) grid.scrollLeft = lefts[c];
  else if (lefts[c] + S.widths[c] > grid.scrollLeft + viewW) grid.scrollLeft = lefts[c] + S.widths[c] - viewW;
}

grid.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy('tsv', false); return; }
  if (!S.focus) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCell(); return; }
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] };
  const m = moves[e.key];
  if (!m) {
    if (e.key === 'Escape') { if (S.cellOpen) closeCell(); else { S.anchor = S.focus = null; render(); updateStatus(); } }
    return;
  }
  e.preventDefault();
  const f = { r: Math.max(0, Math.min(S.rowCount - 1, S.focus.r + m[0])), c: Math.max(0, Math.min(S.columns.length - 1, S.focus.c + m[1])) };
  S.focus = f;
  if (!e.shiftKey) S.anchor = { ...f };
  ensureVisible(f.r);
  ensureColVisible(f.c);
  render();
  updateStatus();
  if (S.cellOpen) requestCell();
});

function copy(format, header = true) {
  if (!S.rowCount || !S.columns.length) return flash('Nothing to copy.');
  const sel = currentSel() || { r0: 0, r1: S.rowCount - 1, c0: 0, c1: S.columns.length - 1 };
  flash('Copying…', true);
  vscode.postMessage({ type: 'copy', format, sel: { ...sel, header } });
}
btnCsv.addEventListener('click', () => copy('csv'));
btnJson.addEventListener('click', () => copy('json'));
btnInsert.addEventListener('click', () => copy('insert'));
btnExport.addEventListener('click', () => { if (S.columns.length) vscode.postMessage({ type: 'export' }); });

// ---------- cell viewer ----------
function openCell() { if (!S.focus) return; S.cellOpen = true; cellPanel.hidden = false; requestCell(); schedule(); }
function closeCell() { S.cellOpen = false; cellPanel.hidden = true; schedule(); grid.focus(); }
function requestCell() {
  if (!S.focus) return;
  cellPanel.textContent = 'Loading…';
  vscode.postMessage({ type: 'cell', row: S.focus.r, col: S.focus.c });
}

function renderCell(msg) {
  if (!S.cellOpen || !S.focus || msg.row !== S.focus.r || msg.col !== S.focus.c) return;
  cellPanel.textContent = '';
  const v = msg.value;
  const top = el('div', 'cellhead');
  top.append(el('strong', null, msg.column), el('span', 'muted', `row ${fmtN(msg.row + 1)} · ${C.kindLabel(v)}`));
  const x = el('button', 'btn close', '×');
  x.title = 'Close (Esc)';
  x.addEventListener('click', closeCell);
  top.append(x);
  cellPanel.append(top);
  if (v.kind === 'null') { cellPanel.append(el('div', 'muted', 'NULL')); return; }
  if (v.kind === 'integer' || v.kind === 'real') { cellPanel.append(el('pre', 'cellpre', v.text)); return; }
  if (v.kind === 'text') {
    if (v.json) {
      let parsed;
      try { parsed = JSON.parse(v.text); } catch { parsed = undefined; }
      if (parsed !== undefined) {
        cellPanel.append(el('div', 'k', 'JSON'));
        cellPanel.append(jsonTree(parsed, 0));
      }
    }
    cellPanel.append(el('div', 'k', v.json ? 'Text' : `Text · ${fmtN(v.length)} characters`));
    cellPanel.append(el('pre', 'cellpre', v.json ? C.prettyJson(v.text) : v.text));
    if (v.cut) cellPanel.append(el('div', 'muted', 'Cut at 2 MB.'));
    return;
  }
  // BLOB
  if (v.image) {
    const img = el('img', 'cellimg');
    img.alt = `${v.blobKind} image, ${M.formatBytes(v.size)}`;
    img.src = v.image;
    cellPanel.append(img);
  }
  for (const vec of v.vectors || []) {
    cellPanel.append(el('div', 'k', `As float${vec.width * 8} vector`));
    const t = el('table', 'fields');
    for (const [k, val] of [['Dimension', fmtN(vec.dim)], ['Min', C.num(vec.min)], ['Max', C.num(vec.max)], ['Mean', C.num(vec.mean)], ['L2 norm', C.num(vec.norm)]]) {
      const tr = el('tr'); tr.append(el('td', 'fname', k), el('td', 'num', val)); t.append(tr);
    }
    cellPanel.append(t);
    cellPanel.append(el('pre', 'cellpre', '[' + vec.head.map(C.num).join(', ') + (vec.dim > vec.head.length ? `, … ${fmtN(vec.dim - vec.head.length)} more]` : ']')));
  }
  cellPanel.append(el('div', 'k', `Hex · ${fmtN(v.size)} bytes` + (v.hexCut ? ' (first 4 KB)' : '')));
  cellPanel.append(el('pre', 'cellpre hex', v.hex));
}

function jsonTree(v, depth) {
  if (v === null || typeof v !== 'object') return el('span', 'j-' + (v === null ? 'null' : typeof v), JSON.stringify(v));
  const isArr = Array.isArray(v);
  const keys = Object.keys(v);
  const d = el('details', 'jnode');
  d.open = depth < 2;
  const sum = el('summary', null, isArr ? `[ ${keys.length} items ]` : `{ ${keys.length} keys }`);
  d.append(sum);
  for (const k of keys.slice(0, 1000)) {
    const line = el('div', 'jline');
    line.append(el('span', 'jkey', isArr ? k : JSON.stringify(k)), el('span', 'muted', ': '));
    line.append(jsonTree(v[k], depth + 1));
    d.append(line);
  }
  if (keys.length > 1000) d.append(el('div', 'muted', `… ${fmtN(keys.length - 1000)} more`));
  return d;
}

// ---------- SQL ----------
function runSql() {
  const sql = sqlInput.value.trim();
  if (!sql) return;
  sqlMsg.textContent = 'Running…';
  sqlMsg.className = 'sqlmsg';
  vscode.postMessage({ type: 'runSql', sql });
}
sqlRun.addEventListener('click', runSql);
sqlInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); } });
sqlHist.addEventListener('change', () => { if (sqlHist.value) sqlInput.value = sqlHist.value; sqlHist.value = ''; sqlInput.focus(); });
function renderHistory() {
  sqlHist.textContent = '';
  const o = el('option', null, S.history.length ? `History (${S.history.length})` : 'No history yet');
  o.value = '';
  sqlHist.append(o);
  for (const h of S.history) { const x = el('option', null, h.length > 90 ? h.slice(0, 90) + '…' : h); x.value = h; sqlHist.append(x); }
}

// ---------- status and banners ----------
let flashTimer = null;
function flash(text, sticky) {
  statusMid.textContent = text;
  clearTimeout(flashTimer);
  if (!sticky) flashTimer = setTimeout(() => { statusMid.textContent = ''; }, 4000);
}

function updateStatus() {
  const src = S.source;
  const what = !src ? '' : src.kind === 'table' ? src.name : 'query result';
  const total = src && src.kind === 'table' && S.objects ? [...S.objects.tables, ...S.objects.views].find(t => t.name === src.name) : null;
  stats.textContent = !src ? '' : `${what} · ${fmtN(S.rowCount)} rows` + (total && total.rows !== null && total.rows !== S.rowCount && !total.estimate ? ` of ${fmtN(total.rows)}` : '') + ` · ${fmtN(S.columns.length)} columns`;
  const sel = currentSel();
  statusLeft.textContent = sel
    ? `Selected ${fmtN(sel.r1 - sel.r0 + 1)} × ${fmtN(sel.c1 - sel.c0 + 1)}` + (sel.r0 === sel.r1 && sel.c0 === sel.c1 ? ' · Enter or double-click opens the cell' : '')
    : S.columns.length ? 'Click a cell. Double-click or Enter shows JSON, images, vectors and hex.' : '';
  statusRight.textContent = S.timing;
  const has = S.columns.length > 0;
  btnCsv.disabled = btnJson.disabled = btnInsert.disabled = btnExport.disabled = !has;
  search.disabled = !S.canFilter || !has;
}

function renderBanners() {
  banners.textContent = '';
  const add = (text, cls) => {
    const b = el('div', 'banner ' + (cls || ''));
    b.append(el('span', null, text));
    if (cls === 'error' && /maxFileSizeMB/.test(text)) {
      const link = el('button', 'link', 'Settings');
      link.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
      b.append(link);
    }
    banners.append(b);
  };
  for (const w of S.warnings) add(w, 'warn');
  if (S.error) add(S.error, 'error');
}

function showEmpty() {
  const o = S.objects;
  const none = o && !o.tables.length && !o.views.length;
  empty.hidden = !(none && S.tab === 'data' && !S.columns.length);
  empty.textContent = none ? 'This database has no tables or views. Use the SQL tab for PRAGMAs, or open another file.' : '';
}

// ---------- messages ----------
window.addEventListener('message', ev => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init':
      S.fileName = msg.fileName;
      title.textContent = msg.fileName;
      S.history = Array.isArray(msg.history) ? msg.history : [];
      renderHistory();
      break;
    case 'history':
      S.history = msg.history;
      renderHistory();
      break;
    case 'warnings':
      S.warnings = msg.warnings;
      renderBanners();
      break;
    case 'opened':
      S.timing = `Opened in ${fmtN(msg.ms)} ms`;
      updateStatus();
      break;
    case 'objects': {
      const first = !S.objects;
      S.objects = msg;
      renderSide();
      showEmpty();
      const pick = msg.tables.find(t => !t.system) || msg.tables[0] || msg.views[0];
      if (first && !S.source && pick) vscode.postMessage({ type: 'openTable', name: pick.name });
      break;
    }
    case 'meta': {
      S.version = msg.version;
      S.source = msg.source;
      S.columns = msg.columns;
      S.canFilter = msg.canFilter;
      S.sort = msg.sort;
      S.filters = M.filtersFromMeta(msg.filters);
      search.value = S.filters.global;
      S.rowCount = msg.viewCount;
      S.cache.clear();
      S.pending.clear();
      S.anchor = S.focus = null;
      S.widths = S.columns.map(c => M.autoWidth(c.name, (c.declared || (c.type === 'any' ? '' : c.type)) + (c.pk ? ' · PK' : ''), []));
      S.autoSized = false;
      rowPool.length = 0;
      body.textContent = '';
      grid.scrollTop = 0;
      grid.scrollLeft = 0;
      GUTTER_W = M.gutterWidth(S.rowCount);
      app.style.setProperty('--gutter-w', GUTTER_W + 'px');
      if (S.cellOpen) closeCell();
      buildHeader();
      gridWrap.hidden = S.tab === 'schema' || !S.columns.length;
      renderSide();
      showEmpty();
      updateStatus();
      layout();
      break;
    }
    case 'rows': {
      const p = S.pending.get(msg.reqId);
      S.pending.delete(msg.reqId);
      if (!p || msg.version !== S.version) { if (p) schedule(); return; }
      S.cache.set(p.page, msg.rows);
      if (S.cache.size > 60) S.cache.delete(S.cache.keys().next().value);
      if (!S.autoSized && msg.rows.length) {
        S.autoSized = true;
        S.widths = S.columns.map((c, i) => M.autoWidth(c.name, (c.declared || (c.type === 'any' ? '' : c.type)) + (c.pk ? ' · PK' : ''), msg.rows.slice(0, 100).map(r => C.display(r.cells[i]).text)));
        buildHeader();
        applyWidths();
        return;
      }
      schedule();
      break;
    }
    case 'view':
      S.version = msg.version;
      S.rowCount = msg.viewCount;
      S.sort = msg.sort;
      S.cache.clear();
      S.pending.clear();
      S.anchor = S.focus = null;
      head.querySelectorAll('.hcell').forEach(h => {
        const c = Number(h.dataset.col);
        h.querySelector('.sort').textContent = S.sort && S.sort.col === c ? (S.sort.dir === 'asc' ? '▲' : '▼') : '';
      });
      flash(`${fmtN(msg.viewCount)} rows · ${fmtN(msg.ms)} ms`);
      updateStatus();
      layout();
      break;
    case 'count':
      if (S.objects) for (const t of [...S.objects.tables, ...S.objects.views]) if (t.name === msg.name) { t.rows = msg.rows; t.estimate = false; }
      renderSide();
      updateStatus();
      break;
    case 'schema':
      if (S.tab === 'schema') renderSchema(msg);
      break;
    case 'cell':
      renderCell(msg);
      break;
    case 'sqlDone':
      sqlMsg.className = 'sqlmsg ok';
      sqlMsg.textContent = `${fmtN(msg.rows)} rows in ${fmtN(msg.ms)} ms` + (msg.more ? ' (first 100,000 shown)' : '');
      break;
    case 'sqlError':
      sqlMsg.className = 'sqlmsg err';
      sqlMsg.textContent = msg.message;
      break;
    case 'copied':
      flash(`Copied ${fmtN(msg.rows)} rows as ${String(msg.format).toUpperCase()}` + (msg.truncated ? ' (cut at the copy limit)' : ''));
      break;
    case 'exporting':
      flash(`Exporting ${String(msg.format).toUpperCase()}…`, true);
      break;
    case 'exported':
      flash(msg.ok ? `Exported ${fmtN(msg.rows)} rows (${M.formatBytes(msg.bytes)})` : 'Export failed.');
      break;
    case 'error':
      if (msg.transient) { flash(msg.message); break; }
      S.error = msg.message;
      renderBanners();
      break;
    default:
      break;
  }
});

setTab('data');
renderHistory();
updateStatus();
vscode.postMessage({ type: 'ready' });
