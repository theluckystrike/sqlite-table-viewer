# SQLite Viewer & DB Viewer (Read-Only)

<a href="https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer"><img src="https://img.shields.io/visual-studio-marketplace/i/zovo.sqlite-table-viewer?label=VS%20Code%20installs" alt="VS Code installs"></a>
<a href="https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer"><img src="https://img.shields.io/visual-studio-marketplace/v/zovo.sqlite-table-viewer?label=version" alt="Version"></a>
<a href="https://github.com/theluckystrike/sqlite-table-viewer/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>

Click a `.db` or `.sqlite` file and this SQLite viewer shows its tables, schema, JSON columns and BLOBs in a fast read-only grid that never writes to the file.

<a href="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/orders-dark.png"><img src="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/orders-dark.png" alt="store.db open on the orders table, filtered to paid orders over 100000 cents and sorted by total, next to the list of 4 tables, 2 views, 3 indexes and 1 trigger with row counts" width="100%"></a>

*Real output. The extension's own webview page, with its Content Security Policy, fed by its real sql.js reader and captured in headless Chrome. store.db is a generated shop database with 50,000 rows (scripts/make-samples.py). It opened in 57 ms.*

- Safe for production files. The database loads into memory read-only. Writes are refused by SQLite itself (`PRAGMA query_only`), and nothing is ever saved back.
- Sees inside cells. JSON text opens as a tree. PNG, JPEG, GIF and WebP BLOBs show as pictures. A float32 embedding shows its dimension, min, max and norm, which helps with sqlite-vec and RAG tables.
- No setup, no network. Plain JavaScript and SQLite compiled to WebAssembly, running offline in VS Code. No telemetry.

## Quick start

1. Install SQLite Table Viewer.
2. Click any `.db`, `.sqlite`, `.sqlite3`, `.db3`, `.s3db`, `.sl3`, `.vscdb` or `.gpkg` file. It opens as a table.

A SQLite file with another name (`.data`, `.store`, no extension) is detected by its "SQLite format 3" header, and VS Code offers to open it here. You can also right-click any file and pick "Open in SQLite Table Viewer".

## More screenshots

| JSON column as a tree, light theme | Schema tab, dark theme |
|---|---|
| <a href="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/json-tree-light.png"><img src="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/json-tree-light.png" alt="types.sqlite with a JSON cell open in the cell viewer as a collapsible tree, next to PNG and float32 BLOB cells" width="100%"></a> | <a href="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/schema-dark.png"><img src="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/schema-dark.png" alt="The Schema tab for the orders table with column types, primary key, NOT NULL, defaults, the foreign key to customers and the CREATE statements" width="100%"></a> |

| SQL box with history, dark theme | Float32 embedding, light theme |
|---|---|
| <a href="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/sql-dark.png"><img src="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/sql-dark.png" alt="A SELECT with a join, GROUP BY and json_extract run in 18 ms, with 30 result rows in the grid" width="100%"></a> | <a href="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/vector-light.png"><img src="https://raw.githubusercontent.com/theluckystrike/sqlite-table-viewer/main/images/vector-light.png" alt="A 384-dimension float32 BLOB decoded as a vector with min, max, mean, L2 norm and the first 64 values, above its hex dump" width="100%"></a> |

## What you can do

Pick a table or view on the left. Each one shows its row count. Indexes and triggers are listed too, and a click shows their SQL.

Click a column header to sort. Clicks cycle through ascending, descending and the table's own order, and NULLs go last. Type in the box under a header to filter that column. Number columns take `>10`, `>=10`, `<5`, `!=3` and ranges like `5..9`. Text matches any part of the value, `=word` matches exactly and `!word` drops rows that contain it. `empty` and `!empty` work everywhere. The search box looks in every column. Every filter value is sent to SQLite as a bound parameter, never pasted into the SQL text.

Rows are fetched one page at a time, so a table with millions of rows scrolls as fast as a small one.

The Schema tab shows each column's declared type, primary key, NOT NULL, default and foreign key, plus the CREATE statements for the table, its indexes and its triggers.

The SQL tab runs one statement at a time. SELECT, WITH, VALUES, EXPLAIN and reading PRAGMAs (`table_info`, `index_list`, `integrity_check` and so on) are allowed. The result fills the same grid, so you can sort, filter and copy it. You see the row count and the time, and the last 20 queries stay in the history list.

Double-click a cell, or press Enter, to open the cell viewer. Text and JSON show in full. A BLOB shows its size and a hex dump, plus the picture for image data and vector stats when the bytes decode as float32 or float64.

Select cells by dragging or with Shift+click, or click row numbers for whole rows. Copy CSV, Copy JSON and Copy INSERT put the selection on the clipboard, and Ctrl+C (Cmd+C on macOS) copies tab-separated values. Export saves every row in view, filtered and sorted, as CSV or JSON.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `sqliteTableViewer.maxFileSizeMB` | `512` | Larger files show a message instead of loading |
| `sqliteTableViewer.copyMaxRows` | `100000` | Most rows copied to the clipboard at once |
| `sqliteTableViewer.exportMaxRows` | `1000000` | Most rows written to one CSV or JSON export |
| `sqliteTableViewer.askForRating` | `true` | Ask one time for a Marketplace rating, after 5 databases and 2 days. Turn it off with `false` |

## Limits

- The whole file is loaded into memory, so files over 512 MB show a message instead (setting `sqliteTableViewer.maxFileSizeMB`).
- Read-only by design. Editing rows is not supported.
- Changes still sitting in a `-wal` file are not shown. When one is present, a banner says so.
- Encrypted databases (SQLCipher, SEE) cannot be opened. They get a clear message, and so do damaged files and files that are not SQLite at all.
- Row counts for files over 100 MB come from `sqlite_stat1` when it exists. Otherwise a "count" button counts on demand.

## Privacy

SQLite Table Viewer makes no network requests and collects no telemetry. The database is read in a worker thread on your machine. The webview runs under a strict Content Security Policy with no remote scripts, and every value from the file is written as plain text, never as HTML.

## Development

```sh
npm install
npm test          # builds with esbuild, makes sample databases in a temp folder, runs node --test
npm run samples   # writes the sample databases to samples/ (Python standard library only)
npm run package   # writes dist/sqlite-table-viewer-<version>.vsix
```

The screenshots come from `scripts/screenshot/live.js`, which serves the real webview page and drives it over the Chrome DevTools Protocol.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [CSV Viewer, Excel Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer & NDJSON Table Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [Claude Code History & Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [HDF5 & NetCDF Explorer (H5 Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, attributes and values in HDF5 and NetCDF files and plots slices.
- [GGUF, Safetensors & NPY Viewer (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [MP4 Video Player & Video Preview with Sound](https://marketplace.visualstudio.com/items?itemName=zovo.video-preview-with-sound) plays MP4, MOV, MKV and WebM files with their sound.
- [DXF Viewer & CAD Viewer for 2D Drawings](https://marketplace.visualstudio.com/items?itemName=zovo.dxf-viewer) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [AGENTS.md & CLAUDE.md Linter (Context Drift)](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale commands, paths and versions in AGENTS.md and CLAUDE.md files.
- [Agent Skills & Claude Skills (Skill Shelf)](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Claude Code Usage & Codex Usage Cost Meter](https://marketplace.visualstudio.com/items?itemName=zovo.ai-usage-meter) shows Claude Code and Codex tokens and estimated cost from your local session files.

Coming soon to the Marketplace, with the code on GitHub now.

- [Avro Viewer, Arrow Viewer & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [TIFF Viewer (16-bit, Float, GeoTIFF)](https://github.com/theluckystrike/tiff-viewer-vscode) opens 16-bit, float, multi-page and GeoTIFF images.
- [EML Viewer & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads EML, EMLX and MBOX email files with remote images blocked.
- [3D Model Viewer (GLB, glTF, STL, OBJ, PLY)](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [PKL Viewer & Pickle Viewer](https://github.com/theluckystrike/pickle-viewer-vscode) opens Python pickle files without Python and never runs their code.
- [DICOM Viewer & NIfTI Viewer for CT and MRI](https://github.com/theluckystrike/dicom-nifti-viewer-vscode) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.
- [ZIP Viewer & Archive Explorer (JAR, TAR, GZ)](https://github.com/theluckystrike/archive-explorer-vscode) browses ZIP, JAR, VSIX, TAR and GZ files, opens entries in tabs and extracts them safely.
- [GCode Viewer & 3D Print Preview](https://github.com/theluckystrike/gcode-viewer-vscode) shows GCode toolpaths in 3D layer by layer, with print time and filament use.
- [EPUB Reader & EPUB Viewer](https://github.com/theluckystrike/epub-reader-vscode) reads EPUB books with a table of contents, search and light, sepia or dark themes.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. sql.js is MIT and SQLite is public domain. See [THIRD-PARTY-NOTICES.txt](https://github.com/theluckystrike/sqlite-table-viewer/blob/HEAD/THIRD-PARTY-NOTICES.txt).
