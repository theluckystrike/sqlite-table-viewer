# Changelog

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
