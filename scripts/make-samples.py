#!/usr/bin/env python3
"""Make the sample databases with the Python standard library. Usage: make-samples.py <outdir>
Every file is generated here from seeded random data. No real database is read or copied."""
import json, math, os, random, sqlite3, struct, sys, zlib

out = sys.argv[1] if len(sys.argv) > 1 else 'samples'
os.makedirs(out, exist_ok=True)
rnd = random.Random(20261106)

def fresh(name):
    p = os.path.join(out, name)
    for s in ('', '-wal', '-shm', '-journal'):
        if os.path.exists(p + s):
            os.remove(p + s)
    return p

def png(w, h, seed):
    """A small gradient PNG built by hand (zlib + crc), so no imaging library is needed."""
    r = random.Random(seed)
    c1 = [r.randrange(256) for _ in range(3)]; c2 = [r.randrange(256) for _ in range(3)]
    raw = b''
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            t = (x + y) / (w + h - 2)
            raw += bytes(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

def vec(dim, seed):
    r = random.Random(seed)
    v = [r.gauss(0, 1) for _ in range(dim)]
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]

# store.db: a small shop. 50,000 rows over 4 tables, foreign keys, 2 views, 3 indexes, 1 trigger.
db = sqlite3.connect(fresh('store.db'))
db.executescript('''
PRAGMA foreign_keys = ON;
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, country TEXT DEFAULT 'US', created_at TEXT NOT NULL, prefs TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, title TEXT NOT NULL, category TEXT, price_cents INTEGER NOT NULL CHECK (price_cents >= 0), stock INTEGER DEFAULT 0);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'new', ordered_at TEXT NOT NULL, total_cents INTEGER);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL DEFAULT 1, unit_cents INTEGER NOT NULL, PRIMARY KEY (order_id, product_id)) WITHOUT ROWID;
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status_date ON orders(status, ordered_at);
CREATE INDEX idx_products_category ON products(category);
CREATE VIEW order_totals AS SELECT o.id AS order_id, c.name AS customer, o.status, SUM(i.qty * i.unit_cents) / 100.0 AS total_usd FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id GROUP BY o.id;
CREATE VIEW top_products AS SELECT p.sku, p.title, SUM(i.qty) AS sold FROM order_items i JOIN products p ON p.id = i.product_id GROUP BY p.id ORDER BY sold DESC LIMIT 50;
CREATE TRIGGER trg_stock AFTER INSERT ON order_items BEGIN UPDATE products SET stock = stock - NEW.qty WHERE id = NEW.product_id; END;
''')
first = ['Ada', 'Grace', 'Linus', 'Mia', 'Noah', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tariq', 'Uma', 'Yuki', 'Zoe', 'Ines', 'Kofi']
last = ['Lovelace', 'Hopper', 'Okafor', 'Nakamura', 'Silva', 'Novak', 'Haddad', 'Larsen', 'Moreau', 'Kim', 'Patel', 'Rossi']
countries = ['US', 'DE', 'FR', 'JP', 'BR', 'IN', 'NG', 'SE', 'CA', 'MX']
cats = ['books', 'garden', 'kitchen', 'toys', 'audio', 'outdoor', 'office']
words = ['oak', 'steel', 'mini', 'pro', 'travel', 'classic', 'eco', 'smart', 'quiet', 'compact', 'deluxe']
NC, NP, NO = 8000, 2000, 15000
cust = []
for i in range(1, NC + 1):
    n = f'{rnd.choice(first)} {rnd.choice(last)}'
    prefs = json.dumps({'newsletter': rnd.random() < 0.4, 'theme': rnd.choice(['dark', 'light']), 'tags': rnd.sample(cats, 2)}) if rnd.random() < 0.6 else None
    cust.append((i, n, f'user{i}@example.com', rnd.choice(countries), f'2025-{rnd.randint(1,12):02d}-{rnd.randint(1,28):02d}', prefs))
db.executemany('INSERT INTO customers VALUES (?,?,?,?,?,?)', cust)
db.executemany('INSERT INTO products VALUES (?,?,?,?,?,?)', [(i, f'SKU-{i:05d}', f'{rnd.choice(words).title()} {rnd.choice(words)} {rnd.choice(cats)[:-1]}', rnd.choice(cats), rnd.randint(199, 29999), 100000) for i in range(1, NP + 1)])
statuses = ['new', 'paid', 'shipped', 'delivered', 'returned']
db.executemany('INSERT INTO orders VALUES (?,?,?,?,NULL)', [(i, rnd.randint(1, NC), rnd.choice(statuses), f'2026-{rnd.randint(1,10):02d}-{rnd.randint(1,28):02d} {rnd.randint(0,23):02d}:{rnd.randint(0,59):02d}') for i in range(1, NO + 1)])
items = set()
while len(items) < 50000 - NC - NP - NO:
    items.add((rnd.randint(1, NO), rnd.randint(1, NP)))
db.executemany('INSERT INTO order_items VALUES (?,?,?,?)', [(o, p, rnd.randint(1, 4), rnd.randint(199, 29999)) for o, p in sorted(items)])
db.execute('UPDATE orders SET total_cents = (SELECT SUM(qty * unit_cents) FROM order_items WHERE order_id = orders.id)')
db.commit(); db.execute('VACUUM'); db.close()

# types.sqlite: every storage class, NULLs, long text, JSON, a PNG and a float32 embedding (dim 384).
db = sqlite3.connect(fresh('types.sqlite'))
db.execute('CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT, i INTEGER, r REAL, t TEXT, j TEXT, b BLOB, emb BLOB)')
rows = [
    (1, 'integers', 42, None, None, None, None, None),
    (2, 'big integer', 9007199254740993, None, None, None, None, None),
    (3, 'negative and real', -7, 3.141592653589793, None, None, None, None),
    (4, 'all null', None, None, None, None, None, None),
    (5, 'long text', None, None, 'Lorem ipsum dolor sit amet. ' * 400, None, None, None),
    (6, 'unicode', None, None, 'Grüße, 東京, emoji 🙂, RTL שלום, <b>not html</b> & "quotes"', None, None, None),
    (7, 'json object', None, None, None, json.dumps({'user': {'id': 7, 'roles': ['admin', 'dev'], 'active': True}, 'scores': [9.5, 7.25, None], 'note': '<script>alert(1)</script>'}), None, None),
    (8, 'json array', None, None, None, json.dumps([{'k': i, 'v': i * i} for i in range(12)]), None, None),
    (9, 'png image', None, None, None, None, png(96, 64, 9), None),
    (10, 'float32 embedding', None, None, None, None, None, struct.pack('<384f', *vec(384, 10))),
    (11, 'raw bytes', None, None, None, None, bytes(range(256)) * 2, None),
    (12, 'mixed types in one column', 'text in an INTEGER column', 1.5, 12, None, None, None),
]
db.executemany('INSERT INTO samples VALUES (?,?,?,?,?,?,?,?)', rows)
db.commit(); db.close()

# vec.db: a table of embeddings, as written by apps that use sqlite-vec style float32 blobs.
db = sqlite3.connect(fresh('vec.db'))
db.execute('CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, chunk INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB NOT NULL, meta TEXT)')
topics = ['billing', 'login', 'search', 'export', 'webhooks', 'rate limits', 'sso', 'audit log']
db.executemany('INSERT INTO chunks VALUES (?,?,?,?,?,?)', [
    (i, f'docs/{rnd.choice(topics).replace(" ", "-")}.md', i % 7, f'How {rnd.choice(topics)} works, part {i % 7 + 1}.', struct.pack('<384f', *vec(384, 1000 + i)), json.dumps({'tokens': rnd.randint(80, 512), 'lang': 'en'}))
    for i in range(1, 1201)])
db.commit(); db.close()

# empty.db: a valid database with 0 tables.
db = sqlite3.connect(fresh('empty.db')); db.execute('PRAGMA user_version = 1'); db.commit(); db.close()

# wal-mode.db: WAL mode, with rows still in the -wal file. The writer stays open until it is killed,
# so the -wal file is left behind. Run with --hold to keep it open; the default copies the files.
p = fresh('wal-mode.db')
db = sqlite3.connect(p)
db.execute('PRAGMA journal_mode = WAL'); db.execute('PRAGMA wal_autocheckpoint = 0')
db.execute('CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, at TEXT)')
db.executemany('INSERT INTO events (kind, at) VALUES (?, ?)', [('checkpointed', f'2026-11-0{1 + i % 5}') for i in range(100)])
db.commit(); db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
db.executemany('INSERT INTO events (kind, at) VALUES (?, ?)', [('only in wal', '2026-11-06') for _ in range(25)])
db.commit()
# Leave the -wal file: copy it aside before close() checkpoints it, then put it back.
wal = open(p + '-wal', 'rb').read()
main = open(p, 'rb').read()
db.close()
open(p, 'wb').write(main); open(p + '-wal', 'wb').write(wal)
if os.path.exists(p + '-shm'):
    os.remove(p + '-shm')

# corrupt.db: a valid 100-byte header, then random pages.
good = open(os.path.join(out, 'empty.db'), 'rb').read(100)
open(fresh('corrupt.db'), 'wb').write(good[:28] + struct.pack('>I', 8) + good[32:] + bytes(rnd.randrange(256) for _ in range(4096 * 8 - 100)))

# not-sqlite.db: a text file with a .db name.
open(fresh('not-sqlite.db'), 'w').write('This is a plain text file with a .db name.\n')

# encrypted.db: random bytes, the way a SQLCipher file looks without its key.
open(fresh('encrypted.db'), 'wb').write(bytes(rnd.randrange(256) for _ in range(4096 * 4)))

for f in sorted(os.listdir(out)):
    s = os.path.getsize(os.path.join(out, f))
    assert s < 5 * 1024 * 1024, f
    print(f'{f:20} {s:>9,}')
