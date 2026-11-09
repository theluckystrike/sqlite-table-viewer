# Changelog

## 0.4.0 (2026-11-10)

- 0.3.0 was never published on its own. 0.4.0 has everything listed under 0.3.0 below: editing, safe Save, CSV import and SQL export.
- Optional Zovo Pro (USD 19 once, all Zovo extensions) with three new tools, each with 3 free tries on every computer. A try counts only when the tool wrote its files.
  - Compare with another database: schema and rows, matched by primary key or rowid. Writes a Markdown report and a SQL script that makes the second database match the first. The script is opened, never run.
  - ER diagram and schema document: SVG and Mermaid diagram of the tables and foreign keys, and a Markdown document of every table.
  - Export all tables: one Excel workbook with a sheet per table, or one CSV file per table.
- Everything that is free stays free, including the table tools (add, rename and drop columns, rename a table, find and replace) and the CSV column transforms.
- A "DB tools" button with a small PRO badge in the editor toolbar, and the same tools in the Command Palette and the Explorer menu of a database file. Nothing about Pro shows when a database opens. The setting `sqliteTableViewer.showProFeatures` (default `true`) hides them.
- New setting `sqliteTableViewer.compareMaxStatements` (1,000,000).
- In Cursor, Windsurf, VSCodium and other editors that install from Open VSX, "Rate" opens the Open VSX review page. VS Code still opens the Marketplace page. The rating question also comes to people who keep one window open for days.
- "More free viewers" now starts with the Zovo extensions most related to this one. The README lists them under "More tools by Zovo".

## 0.3.0 (2026-11-09, not published, shipped in 0.4.0)

- Support links: PayPal next to GitHub Sponsors. "More free viewers" lists the XLSX viewer and the Spreadsheet Editor first.
- Editing. A database still opens read-only. Click "Enable editing" to change it. Before that it tells you when another program has the file open, when the `-wal` file holds transactions that are not in the main file yet, or when a `-journal` shows a write in progress.
- Change cells in place (double-click, Enter, F2 or just type). Values are stored by the column type: INTEGER, REAL, TEXT, NULL, or a BLOB from hex or from a file. Delete sets a cell to NULL.
- Insert, duplicate and delete rows. INSERT, UPDATE, DELETE, CREATE and ALTER run in the SQL box.
- Every change waits in a pending list that shows the SQL, with Undo and Discard. A CHECK, NOT NULL, UNIQUE or foreign key error refuses only that change.
- Save (Ctrl+S or Cmd+S) checks foreign keys and `quick_check`, makes a backup copy (`name.db.YYYYMMDD-HHMMSS.bak` next to the file, or in `~/.zovo-sqlite-backups`), writes the new file to a temp file, flushes it to disk and swaps it in with a rename. A file that changed on disk since you opened it is never overwritten, and your changes stay.
- "Checkpoint and reload" for a database whose `-wal` file has transactions in it (runs `PRAGMA wal_checkpoint(TRUNCATE)` with the sqlite3 tool).
- CSV and TSV import into a new or an existing table: preview of the first 200 rows, delimiter, encoding (UTF-8, Windows-1252, UTF-16), header row, column names, types and mapping. The file is read in 1 MB pieces with a progress bar and Cancel. 1,000,000 rows import and save in about 3 seconds in the tests.
- "Import CSV into a new SQLite database" on any `.csv` file in the Explorer.
- Export to SQL INSERT statements, next to CSV and JSON.
- Table tools: add, rename and drop columns, rename a table, and find and replace in a column. All staged with Undo.
- Grid rows of a table are now always in row key order when no sort is set, so a row number points at the same row for every query.
- New settings: `sqliteTableViewer.editMaxFileSizeMB` (256), `sqliteTableViewer.backupLocation`, `sqliteTableViewer.enforceForeignKeys`. Larger files still open read-only.
- The Marketplace name is now "SQLite Editor & Viewer, SQLite3 Database Browser (Edit Cells, CSV Import)". The extension ID, settings and commands stay the same.

## 0.2.3 (2026-11-08)

- The Marketplace name is now "SQLite Viewer & SQLite3 DB File Browser, Database Explorer" (was "SQLite DB Viewer & SQLite Viewer, Database Viewer (Read-Only)"), so more searches find it. The extension ID, settings and commands stay the same.
- The short description now starts with what the name does not say: free and read-only, with no paywall, ads or sign-in.
- A brighter icon with the file type on it, easier to spot in the Extensions view. No change to how files open or look.

## 0.2.2 (2026-11-08)

- The Marketplace name is now "SQLite DB Viewer & SQLite Viewer, Database Viewer (Read-Only)", so a search for SQLite DB finds it. The extension ID, settings and commands stay the same.
- The README and the Marketplace description now start with what was already true: it is free, with no paywall, no ads, no license banner and no sign-in.
- A 0-byte file now says that the file is empty, instead of "This database has no tables or views".
- A view that returns rows without end (a `WITH RECURSIVE` view with no stop) no longer leaves the table list blank. View counts in the list stop at 1,000,000 (the "count" button shows instead), and paging over a view or a SQL query stops at 10,000,000 rows.
- The rating question now comes after 3 databases that opened without an error on 2 different days, and never after an error. "Later" asks one more time after 7 days, "No thanks" ends it, and it never asks more than 2 times. `sqliteTableViewer.askForRating: false` turns it off.

## 0.2.1 (2026-11-08)

- The "More free viewers" list and the README now use the current Marketplace names and include the newest Zovo extensions: ZIP, GCode, EPUB, HAR, font and audio viewers.

## 0.2.0 (2026-11-07)

- Rows that are still in the `-wal` file now show. An app with the database open in WAL mode (Django, Rails, Prisma, Electron apps, browsers) keeps new rows in `name.db-wal` until a checkpoint. The viewer reads the committed transactions from that file into its in-memory copy, the way SQLite does, and a blue line says how many it added. A half-written transaction at the end is skipped. Neither file is written.
- Live reload. When the database or its `-wal` file changes on disk, the view reloads by itself and keeps the table, sort, filters, scroll position and open cell. The "Live" button turns this off (setting `sqliteTableViewer.autoReload`), and then a notice with a Reload button shows instead. "Reload" in the toolbar reads the file again at any time.
- If a reload fails because the file is in the middle of a write, the old view stays on screen and the viewer tries once more.

## 0.1.6 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.5 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.
- The Marketplace description now starts with the file types and the viewer name people search for.
- Marketplace search keywords updated.

## 0.1.4 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with CSV Viewer, Excel Viewer & Parquet Viewer and Large JSON Viewer & JSON Tree.

## 0.1.3 (2026-11-07)

- The Marketplace name is now "SQLite Viewer & DB Viewer (Read-Only)", so a search for SQLite viewer or DB viewer finds it. The extension ID, settings and commands stay the same.

## 0.1.2 (2026-11-06)

- The status line at the bottom of the viewer ends with two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `sqliteTableViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "SQLite Table Viewer: Support the developer" and "SQLite Table Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.1 (2026-11-06)

- SQLite Table Viewer asks one time for a Marketplace rating. It counts each database that opens in the viewer. After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `sqliteTableViewer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.
- The hex view of a BLOB cell no longer runs past the side panel. It fits the panel width and scrolls inside it.

## 0.1.0 (2026-11-06)

- First release.
- Read-only custom editor for .db, .sqlite, .sqlite3, .db3, .s3db, .sl3, .vscdb and .gpkg files, plus a header check for other names.
- Tables, views, indexes and triggers with row counts. Paged grid with sort, column filters and search, all with bound parameters.
- Schema tab, a read-only SQL box with a 20-query history, and a cell viewer for JSON, images, float32 vectors and hex.
- Copy as CSV, JSON or INSERT. Export to CSV or JSON.
- Warnings for -wal files, a 512 MB limit, and clear errors for encrypted, damaged and non-SQLite files.
