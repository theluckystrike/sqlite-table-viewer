# Changelog

## 0.1.0 (2026-11-06)

- First release.
- Read-only custom editor for .db, .sqlite, .sqlite3, .db3, .s3db, .sl3, .vscdb and .gpkg files, plus a header check for other names.
- Tables, views, indexes and triggers with row counts. Paged grid with sort, column filters and search, all with bound parameters.
- Schema tab, a read-only SQL box with a 20-query history, and a cell viewer for JSON, images, float32 vectors and hex.
- Copy as CSV, JSON or INSERT. Export to CSV or JSON.
- Warnings for -wal files, a 512 MB limit, and clear errors for encrypted, damaged and non-SQLite files.
