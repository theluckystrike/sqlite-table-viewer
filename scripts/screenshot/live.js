// Live harness for the SQLite Table Viewer webview: the real html.js page (with its CSP), the real
// dist/webview.js, the real protocol check and the real Session on sql.js, driven over CDP.
// Usage: node scripts/screenshot/live.js <extRoot> <cdpPort> <outDir> <scenario> <samplesDir>
//   scenarios: orders-dark, types-light, sql-dark, wal-dark, corrupt-dark
// cdpPort: a Chrome started with ~/bin/agent-chrome (AGENT_CHROME_HEADLESS=1).
const fs = require('fs');
const http = require('http');
const path = require('path');
const [root, cdpPort, out, scenario, samples] = process.argv.slice(2);
const { buildHtml } = require(root + '/src/html');
const { validateWebviewMessage } = require(root + '/src/core/protocol');
const { openSession } = require(root + '/src/core/session');
const initSqlJs = require(root + '/node_modules/sql.js/dist/sql-wasm.js');

const THEMES = {
  dark: `--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
  --vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;--vscode-button-secondaryHoverBackground:#3c3c3c;
  --vscode-editor-selectionBackground:#264f78;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-textLink-foreground:#4daafc;--vscode-errorForeground:#f85149;--vscode-editorWarning-background:#cca70033;--vscode-editorWarning-foreground:#cca700;--vscode-inputValidation-errorBackground:#5a1d1d;--vscode-textCodeBlock-background:#2b2b2b;
  --vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-orange:#d18616;--vscode-charts-purple:#b180d7;--vscode-charts-yellow:#cca700;`,
  light: `--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;
  --vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-button-secondaryHoverBackground:#cccccc;
  --vscode-editor-selectionBackground:#add6ff;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e4e6f1;--vscode-list-activeSelectionForeground:#000;--vscode-textLink-foreground:#005fb8;--vscode-errorForeground:#f85149;--vscode-editorWarning-background:#bf880033;--vscode-editorWarning-foreground:#895503;--vscode-inputValidation-errorBackground:#f2dede;--vscode-textCodeBlock-background:#f2f2f2;
  --vscode-charts-blue:#1a85ff;--vscode-charts-green:#388a34;--vscode-charts-orange:#d18616;--vscode-charts-purple:#652d90;--vscode-charts-yellow:#bf8803;`,
};
const SCENARIOS = {
  'orders-dark': { theme: 'dark', file: 'store.db' },
  'types-light': { theme: 'light', file: 'types.sqlite' },
  'sql-dark': { theme: 'dark', file: 'store.db' },
  'wal-dark': { theme: 'dark', file: 'wal-mode.db' },
  'corrupt-dark': { theme: 'dark', file: 'corrupt.db' },
  'vec-dark': { theme: 'dark', file: 'vec.db' },
};
const sc = SCENARIOS[scenario];
const file = path.join(samples, sc.file);
const fileName = sc.file;
const shim = `window.acquireVsCodeApi = () => { let st = null; return {
  postMessage: m => window.hostPost(JSON.stringify(m)), getState: () => st, setState: s => { st = s; } }; };`;
const files = { '/webview.js': [path.join(root, 'dist/webview.js'), 'text/javascript'], '/webview.css': [path.join(root, 'media/webview.css'), 'text/css'] };
const NONCE = 'harnessnonceharnessnonceharness0';
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/index.html') {
    let html = buildHtml({ cspSource: `http://127.0.0.1:${server.address().port}`, scriptUri: '/webview.js', styleUri: '/webview.css', title: fileName, nonce: NONCE });
    html = html.replace('<link rel="stylesheet"', '<link rel="stylesheet" href="/theme.css"><link rel="stylesheet"')
      .replace('<script nonce', `<script nonce="${NONCE}" src="/shim.js"></script><script nonce`);
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
  }
  if (u === '/shim.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(shim); }
  if (u === '/theme.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(`html{${THEMES[sc.theme]}--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Monaco,monospace;}`);
  }
  const f = files[u];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f[1] }); fs.createReadStream(f[0]).pipe(res);
});

(async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm.wasm')) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waits = new Map(); const logs = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
  const toWebview = msg => send('Runtime.evaluate', { expression: `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(msg)} }))` });
  let session = null; let fatal = null; let copied = null; const seen = [];
  const history = [];
  const host = msg => {
    seen.push(msg.type);
    if (msg.type === 'ready') {
      toWebview({ type: 'init', fileName, history });
      if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size > 0) toWebview({ type: 'warnings', warnings: [`A ${fileName}-wal file sits next to this database: uncommitted WAL changes are not shown. Rows written since the last checkpoint are missing until the app that owns the database checkpoints or closes it.`] });
      if (!session && !fatal) {
        try { const t0 = Date.now(); session = openSession(SQL, fs.readFileSync(file)); toWebview({ type: 'opened', ms: Date.now() - t0 }); toWebview(session.objectsMessage()); } catch (e) { fatal = { type: 'error', message: e.message }; toWebview(fatal); }
      }
      return;
    }
    if (msg.type === 'runSql') { history.unshift(msg.sql); toWebview({ type: 'history', history }); }
    if (!session) return;
    for (const o of session.handle(msg)) {
      if (o.type === 'copyResult') { copied = o; toWebview({ type: 'copied', rows: o.rows, format: o.format }); continue; }
      toWebview(o);
    }
  };
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); return; }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'hostPost') {
      const msg = validateWebviewMessage(JSON.parse(m.params.payload));
      if (msg) host(msg); else logs.push('REJECTED ' + m.params.payload.slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ' ' + m.params.entry.text);
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Runtime.addBinding', { name: 'hostPost' });
  await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W || 1280), height: Number(process.env.H || 720), deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  const waitRows = async () => { for (let i = 0; i < 100; i++) { await sleep(100); if (await evalJs(`!!document.querySelector('.body .row .cell:not(.gutter):not(.pending)')`).catch(() => false)) break; } await sleep(300); };
  const box = async (sel, idx = 0) => JSON.parse(await evalJs(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(10, b.width / 2), y: b.y + b.height / 2 }); })()`));
  const cellPos = async (r, c) => { await evalJs(`(() => { const row = document.querySelectorAll('.body .row:not([hidden])')[${r}]; const hit = [...row.querySelectorAll('.cell')].find(x => x._c === ${c}); if (!hit || hit.getBoundingClientRect().right > (document.querySelector('.cellpanel').hidden ? innerWidth : document.querySelector('.cellpanel').getBoundingClientRect().left)) { document.querySelector('.grid').scrollLeft = [...document.querySelectorAll('.hcell')].slice(0, ${c}).reduce((a, h) => a + h.offsetWidth, 0); } })()`); await sleep(150);
    return JSON.parse(await evalJs(`(() => { const row = document.querySelectorAll('.body .row:not([hidden])')[${r}]; const b = [...row.querySelectorAll('.cell')].find(x => x._c === ${c}).getBoundingClientRect(); return JSON.stringify({x: b.x + 10, y: b.y + 8}); })()`)); };
  const click = async (p, mod = 0, count = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    for (let k = 1; k <= count; k++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: k, modifiers: mod });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: k, modifiers: mod });
    }
  };
  const typeText = async text => { for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); };
  const btn = async text => JSON.parse(await evalJs(`(() => { const e = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(text)} && b.offsetParent); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  const item = async name => box(`.item[data-name="${name}"]`);
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); console.log('shot', name); };
  const headerIdx = async name => evalJs(`[...document.querySelectorAll('.hcell')].findIndex(h => h.querySelector('.hname').textContent.replace('🔑 ', '') === ${JSON.stringify(name)})`);
  const settle = () => sleep(700);
  const result = { scenario, file: fileName };

  await sleep(800);
  if (scenario === 'orders-dark') {
    await waitRows();
    await click(await item('orders')); await waitRows();
    await click(await box('.fcell input', await headerIdx('status'))); await typeText('=paid'); await settle();
    await click(await box('.fcell input', await headerIdx('total_cents'))); await typeText('>100000'); await settle();
    const h = await headerIdx('total_cents');
    await click(await box('.hcell', h)); await settle(); await click(await box('.hcell', h)); await settle();
    await click(await cellPos(1, 0)); await click(await cellPos(4, 4), 8); await sleep(300);
    result.stats = await evalJs(`document.querySelector('.stats').textContent`);
    await shot('orders-dark.png');
    await click(await btn('Copy INSERT')); await sleep(400);
    result.insert = copied && copied.text.split('\n')[0];
    await click(await btn('Schema')); await settle();
    await shot('schema-dark.png');
    result.schemaRows = await evalJs(`document.querySelectorAll('.schema .fields tr').length`);
  } else if (scenario === 'types-light') {
    await waitRows();
    await click(await cellPos(8, 6), 0, 2); await settle();
    result.img = await evalJs(`(() => { const i = document.querySelector('.cellimg'); return i ? i.naturalWidth + 'x' + i.naturalHeight : null; })()`);
    await shot('blob-image-light.png');
    await click(await cellPos(6, 5)); await settle();
    result.jsonNodes = await evalJs(`document.querySelectorAll('.cellpanel .jline').length`);
    await shot('json-tree-light.png');
    await click(await cellPos(9, 7)); await settle();
    result.vector = await evalJs(`document.querySelector('.cellpanel .fields') && document.querySelector('.cellpanel .fields').textContent`);
    await shot('vector-light.png');
    result.xssSafe = await evalJs(`!document.querySelector('.grid b, .cellpanel script, .grid script')`);
  } else if (scenario === 'vec-dark') {
    await waitRows();
    await click(await cellPos(2, 4), 0, 2); await settle();
    result.vector = await evalJs(`document.querySelector('.cellpanel .fields') && document.querySelector('.cellpanel .fields').textContent`);
    await shot('vector-dark.png');
  } else if (scenario === 'sql-dark') {
    await waitRows();
    await click(await btn('SQL')); await sleep(200);
    await click(await box('.sqlinput'));
    await evalJs(`document.querySelector('.sqlinput').value = ${JSON.stringify("SELECT c.country, COUNT(DISTINCT o.id) AS orders, ROUND(SUM(o.total_cents) / 100.0, 2) AS revenue_usd,\n       json_extract(c.prefs, '$.theme') AS theme\nFROM orders o JOIN customers c ON c.id = o.customer_id\nWHERE o.status IN ('paid', 'shipped', 'delivered')\nGROUP BY c.country, theme ORDER BY revenue_usd DESC")}`);
    await click(await btn('Run')); await settle(); await waitRows();
    result.sqlMsg = await evalJs(`document.querySelector('.sqlmsg').textContent`);
    await shot('sql-dark.png');
    await evalJs(`document.querySelector('.sqlinput').value = ''`);
    await click(await box('.sqlinput')); await typeText('DELETE FROM orders'); await click(await btn('Run')); await settle();
    result.deleteMsg = await evalJs(`document.querySelector('.sqlmsg').textContent`);
    await shot('sql-blocked-dark.png');
  } else if (scenario === 'wal-dark' || scenario === 'corrupt-dark') {
    await sleep(1200);
    result.banner = await evalJs(`document.querySelector('.banners').textContent`);
    await shot(`${scenario}.png`);
  }
  result.consoleErrors = logs;
  result.messages = [...new Set(seen)];
  console.log(JSON.stringify(result));
  await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
  ws.close(); server.close();
  process.exit(0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
