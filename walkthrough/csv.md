# Import CSV and TSV

- "Import CSV" in the toolbar adds a table to the open database, or adds rows to an existing table.
- Right-click a `.csv` file and pick "Import CSV into a new SQLite database" to make a new `.db` file from it.
- The preview shows the first 200 rows. Pick the delimiter (comma, semicolon, tab, pipe), the encoding (UTF-8, Windows-1252, UTF-16) and whether the first row is the header. Column types are guessed: INTEGER, REAL or TEXT, and values with leading zeros stay TEXT.
- The file is read in 1 MB pieces, so a 1M-row file does not fill memory. A progress bar shows the rows, and "Cancel" rolls everything back.
- The import is one staged change: Undo removes it, Save writes it.
