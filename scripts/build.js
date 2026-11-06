'use strict';
// Bundles the extension host, the worker and the webview with esbuild, and copies the sql.js wasm.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), path.join(root, 'dist/sql-wasm.wasm'));
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/worker.js'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs', target: 'node18' }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch(() => process.exit(1));
