# Edit safely

1. The file opens read-only. Click "Enable editing". If another program has the file open, or the `-wal` file holds transactions that are not in the main file yet, you see that first.
2. Double-click a cell, press Enter or F2, or just start typing. Delete sets one cell to NULL; with whole rows selected it deletes them.
3. "+ Row", "Duplicate" and "Delete rows" work on the selected rows. INSERT, UPDATE, DELETE, CREATE and ALTER run in the SQL box.
4. Every change waits in the pending list. "Show SQL" lists the statements, "Undo" takes back the last one.
5. "Save" (Ctrl+S or Cmd+S) checks constraints and foreign keys, writes a backup copy (`name.db.YYYYMMDD-HHMMSS.bak`), writes the new file to a temp file, flushes it to disk and swaps it in. If the file changed on disk since you opened it, Save refuses and keeps your changes.
