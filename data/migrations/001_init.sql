CREATE TABLE IF NOT EXISTS books (
  id               TEXT    PRIMARY KEY,
  isbn             TEXT,
  title            TEXT    NOT NULL,
  author           TEXT    NOT NULL,
  publisher        TEXT,
  condition        TEXT    NOT NULL
                   CHECK (condition IN ('Poor','Acceptable','Good','Very Good','Like New')),
  acquisition_cost INTEGER NOT NULL,
  acquisition_date TEXT    NOT NULL
                   CHECK (acquisition_date LIKE '____-__-__'),
  status           TEXT    NOT NULL DEFAULT 'Unlisted'
                   CHECK (status IN ('Unlisted','Listed','Sale Pending','Sold',
                                     'Removed','Donated','Discarded')),
  listing_price    INTEGER,
  sale_price       INTEGER,
  sale_platform    TEXT,
  sale_date        TEXT
                   CHECK (sale_date IS NULL OR sale_date LIKE '____-__-__'),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
                   CHECK (created_at LIKE '____-__-__%'),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
                   CHECK (updated_at LIKE '____-__-__%'),
  CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL),
  CHECK (status != 'Sold' OR sale_price IS NOT NULL),
  CHECK (status != 'Sold' OR sale_date IS NOT NULL),
  CHECK (status != 'Sold' OR sale_platform IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_isbn   ON books(isbn) WHERE isbn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_status        ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_condition     ON books(condition);
CREATE INDEX IF NOT EXISTS idx_books_title         ON books(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_author        ON books(author COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_created_at    ON books(created_at);
CREATE INDEX IF NOT EXISTS idx_books_sale_date     ON books(sale_date);

CREATE TABLE IF NOT EXISTS book_platforms (
  id          TEXT    PRIMARY KEY,
  book_id     TEXT    NOT NULL REFERENCES books(id),
  platform    TEXT    NOT NULL,
  listed_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bp_book ON book_platforms(book_id);

CREATE TABLE IF NOT EXISTS price_history (
  id             TEXT    PRIMARY KEY,
  book_id        TEXT    NOT NULL REFERENCES books(id),
  previous_price INTEGER NOT NULL,
  new_price      INTEGER NOT NULL,
  changed_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ph_book ON price_history(book_id);
