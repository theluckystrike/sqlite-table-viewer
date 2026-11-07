# Changelog

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
