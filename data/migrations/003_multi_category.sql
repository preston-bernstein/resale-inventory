-- Migration 003_multi_category.sql
-- Table-rebuild migration per book-seller-change-control §4 and the DR-7 precedent
-- (data/migrations/002_price_history_nullable.sql). SQLite cannot ALTER a CHECK
-- constraint, so `condition` moves off the base table entirely — it becomes two
-- independent per-category enums living on book_details and clothing_details,
-- per docs/reseller-architecture-research.md §2/§5. Applied inside a single
-- db.transaction() in lib/db.ts, guarded by PRAGMA user_version = 3.
--
-- Rollback strategy: `books` and `book_platforms` are RENAMED to *_archived
-- below, never DROPped, in this migration — a code-enforced snapshot beats
-- relying solely on the operator's manual pre-migration backup. The actual
-- DROP of the archived tables is deferred to a future migration 004, to be
-- written only after the new schema has run stable in production for at
-- least one release cycle. `price_history` IS rebuilt (create-copy-drop-
-- rename, see below) — a plain column rename was tried first and found to
-- leave its foreign key pointing at the wrong table (see the comment at the
-- rebuild itself) — but every row's data is carried forward unchanged, so
-- this carries none of the "lose data if the copy logic is wrong" risk that
-- motivates archiving `books`/`book_platforms` instead of just rebuilding
-- them the same way.

PRAGMA defer_foreign_keys = ON;
-- Scoped to this transaction only — SQLite resets it to OFF automatically at
-- commit/rollback. Every table below is created and populated in an order
-- that already satisfies FK ordering under foreign_keys=ON (nothing is
-- inserted before the row it references exists), so this pragma isn't
-- strictly load-bearing today. It's a guard against that ordering silently
-- becoming wrong if a future edit reorders these statements, so the
-- rename/archive step's FK-safety is explicit rather than incidental.

-- 1. New base table. Same shape as `books` minus isbn/author/publisher/condition
--    (moved to book_details), plus `category`. All existing status CHECKs
--    preserved verbatim; money fields gain explicit non-negativity CHECKs
--    that previously existed only at the API layer.
CREATE TABLE items (
  id               TEXT    PRIMARY KEY,          -- UUIDv4
  category         TEXT    NOT NULL
                   CHECK (category IN ('book','clothing')),  -- value set only; immutability
                                                              -- (FR2) is enforced by the
                                                              -- PATCH allowlist (API contract)
                                                              -- AND, as defense-in-depth, by
                                                              -- the items_category_immutable
                                                              -- trigger below
  title            TEXT    NOT NULL,              -- book title / clothing short name
  acquisition_cost INTEGER NOT NULL               -- cents (USD)
                   CHECK (acquisition_cost >= 0),
  acquisition_date TEXT    NOT NULL               -- ISO-8601 date
                   CHECK (acquisition_date LIKE '____-__-__'),
  status           TEXT    NOT NULL DEFAULT 'Unlisted'
                   CHECK (status IN ('Unlisted','Listed','Sale Pending','Sold',
                                     'Removed','Donated','Discarded')),
  listing_price    INTEGER                        -- cents; NULL = not priced
                   CHECK (listing_price IS NULL OR listing_price >= 0),
  sale_price       INTEGER                        -- cents; set on → Sold, immutable after
                   CHECK (sale_price IS NULL OR sale_price >= 0),
  sale_platform    TEXT,
  sale_date        TEXT                           -- ISO-8601 date
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

-- Defense-in-depth for FR2 (category immutable after creation). The CHECK
-- above only constrains the value set, not immutability; this trigger backs
-- up the API-layer discipline (PATCH /api/items/:id uses an explicit field
-- ALLOWLIST that never includes `category` — see API contract) with a real
-- DB-level guarantee that fires regardless of which code path issues the
-- UPDATE.
CREATE TRIGGER items_category_immutable
BEFORE UPDATE ON items
WHEN NEW.category != OLD.category
BEGIN
  SELECT RAISE(FAIL, 'category is immutable');
END;

-- 2. Book satellite: isbn, author, publisher, and the book's own condition enum
--    (unchanged 5-value vocabulary, moved verbatim off `books`). Legacy
--    ISBN-10 values are copied as-is in the data migration below — see the
--    "Legacy ISBN caveat" note after this SQL block.
CREATE TABLE book_details (
  item_id    TEXT PRIMARY KEY REFERENCES items(id),
  isbn       TEXT,                                -- NULL if none; ISBN-13 going forward —
                                                    -- pre-existing rows may still be ISBN-10
  author     TEXT NOT NULL,
  publisher  TEXT,
  condition  TEXT NOT NULL
             CHECK (condition IN ('Poor','Acceptable','Good','Very Good','Like New'))
);

-- 3. Clothing satellite: brand/size/color/material/measurements + clothing's own
--    condition enum, independent of the book enum (FR5/FR7/AC4/AC5). weight_oz
--    is a non-negative INTEGER per requirements FR10/AC9 (matches USPS ounce-tier
--    billing granularity per research doc §4 — no float weight math); the CHECK
--    below rejects non-integer values explicitly, since INTEGER column affinity
--    alone does not reject a value like 5.5 in SQLite. All 8 measurement columns
--    get the same non-negativity CHECK weight_oz already had, for consistency.
CREATE TABLE clothing_details (
  item_id           TEXT PRIMARY KEY REFERENCES items(id),
  brand             TEXT NOT NULL,
  size_label        TEXT NOT NULL,                -- free text, as-entered, never normalized (FR9)
  color             TEXT,
  material          TEXT,
  gender_department TEXT,
  weight_oz         INTEGER
                    CHECK (weight_oz IS NULL OR
                           (weight_oz >= 0 AND weight_oz = CAST(weight_oz AS INTEGER))),
  pit_to_pit_in     REAL CHECK (pit_to_pit_in    IS NULL OR pit_to_pit_in    >= 0),
  length_in         REAL CHECK (length_in        IS NULL OR length_in        >= 0),
  sleeve_length_in  REAL CHECK (sleeve_length_in IS NULL OR sleeve_length_in >= 0),
  waist_in          REAL CHECK (waist_in         IS NULL OR waist_in         >= 0),
  rise_in           REAL CHECK (rise_in          IS NULL OR rise_in          >= 0),
  inseam_in         REAL CHECK (inseam_in        IS NULL OR inseam_in        >= 0),
  leg_opening_in    REAL CHECK (leg_opening_in   IS NULL OR leg_opening_in   >= 0),
  hip_in            REAL CHECK (hip_in           IS NULL OR hip_in           >= 0),
  condition         TEXT NOT NULL
                    CHECK (condition IN ('NWT','NWOT','EUC','GUC','Fair'))
);

-- 4. Photos — category-agnostic, new table. Not exercised by books (FR14).
--    created_at gets the same date-format CHECK already used on `items`.
CREATE TABLE item_photos (
  id          TEXT    PRIMARY KEY,                -- UUIDv4
  item_id     TEXT    NOT NULL REFERENCES items(id),
  path        TEXT    NOT NULL,                    -- filesystem-relative path under data/photos/
  sort_order  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
             CHECK (created_at LIKE '____-__-__%')
);

-- 5. item_platforms — rebuild of book_platforms, same shape, category-agnostic,
--    item_id in place of book_id. UNIQUE(item_id, platform) prevents the same
--    item being double-listed on the same platform twice; listed_at gets the
--    same date-format CHECK used elsewhere.
CREATE TABLE item_platforms (
  id          TEXT    PRIMARY KEY,                -- UUIDv4
  item_id     TEXT    NOT NULL REFERENCES items(id),
  platform    TEXT    NOT NULL,
  listed_at   TEXT    NOT NULL
             CHECK (listed_at LIKE '____-__-__%'),
  UNIQUE (item_id, platform)
);

-- === Data migration (inside the same transaction) ===
-- Indexes are deliberately created AFTER these copies (see bottom of this
-- file) to avoid paying per-row index-maintenance cost during the bulk copy.

INSERT INTO items (id, category, title, acquisition_cost, acquisition_date, status,
                    listing_price, sale_price, sale_platform, sale_date,
                    created_at, updated_at)
  SELECT id, 'book', title, acquisition_cost, acquisition_date, status,
         listing_price, sale_price, sale_platform, sale_date,
         created_at, updated_at
  FROM books;

INSERT INTO book_details (item_id, isbn, author, publisher, condition)
  SELECT id, isbn, author, publisher, condition
  FROM books;

INSERT INTO item_platforms (id, item_id, platform, listed_at)
  SELECT id, book_id, platform, listed_at
  FROM book_platforms;

-- price_history: REBUILT, not just column-renamed. An earlier draft of this
-- migration used a single `ALTER TABLE price_history RENAME COLUMN book_id
-- TO item_id`, on the theory that SQLite 3.25+ auto-retargets FK/index
-- definitions that reference the renamed column. That's only half true:
-- verified live (2026-07-11) via `.schema price_history` after running that
-- version of this migration — SQLite DOES rename the column everywhere, but
-- the FK's REFERENCED TABLE stayed exactly what it was before: `books`. Since
-- `books` is renamed to `books_archived` a few statements below, SQLite's
-- table-rename propagation retargets the FK to `books_archived(id)`, NOT to
-- `items(id)` as intended. Every book row that existed BEFORE this migration
-- still validates by coincidence (its id is present in both `items` and
-- `books_archived`, since items.id was copied verbatim from books.id above).
-- Every item created AFTER this migration — book or clothing — has an id
-- that was never in `books`/`books_archived`, so its first price_history
-- insert fails `SQLITE_CONSTRAINT_FOREIGNKEY`. Reproduced via the app's own
-- PATCH /api/items/:id route (set a listing_price on a freshly created
-- item) before this fix. A column rename cannot retarget a FK to a
-- table the constraint never mentioned; only a rebuild can, so this now
-- follows the same create-copy-drop-rename protocol as every other
-- rebuilt table in this migration, with the FK correctly pointed at
-- `items(id)` from the start.
CREATE TABLE price_history_v2 (
  id             TEXT    PRIMARY KEY,             -- UUIDv4
  item_id        TEXT    NOT NULL REFERENCES items(id),
  previous_price INTEGER,                          -- cents; NULL = no prior price
  new_price      INTEGER,                          -- cents; NULL = price cleared
  changed_at     TEXT    NOT NULL                  -- ISO-8601 datetime
);

INSERT INTO price_history_v2 (id, item_id, previous_price, new_price, changed_at)
  SELECT id, book_id, previous_price, new_price, changed_at
  FROM price_history;

DROP TABLE price_history;
ALTER TABLE price_history_v2 RENAME TO price_history;
CREATE INDEX idx_ph_item ON price_history(item_id);

-- === Archive (not drop) the superseded tables ===
-- Renaming rather than dropping gives a zero-effort rollback path: if a
-- problem surfaces after this migration ships, the pre-migration data is
-- still sitting right here under an *_archived name — no restore-from-backup
-- required. The actual DROP of these two tables is deferred to a future
-- migration 004, to be written once the new schema has run stable in
-- production for at least one release cycle.
ALTER TABLE books RENAME TO books_archived;
ALTER TABLE book_platforms RENAME TO book_platforms_archived;

-- === Indexes (created after the copy above — avoids per-row
--     index-maintenance cost during the bulk INSERT...SELECT copy) ===

CREATE INDEX idx_items_category        ON items(category);
CREATE INDEX idx_items_status          ON items(status);
CREATE INDEX idx_items_category_status ON items(category, status);   -- per-category dashboard breakdown (FR17)
CREATE INDEX idx_items_title           ON items(title COLLATE NOCASE);
CREATE INDEX idx_items_created_at      ON items(created_at);
CREATE INDEX idx_items_sale_date       ON items(sale_date) WHERE sale_date IS NOT NULL;
                                        -- partial: only sold-item reporting needs this,
                                        -- and most rows have a NULL sale_date

CREATE UNIQUE INDEX idx_book_details_isbn ON book_details(isbn) WHERE isbn IS NOT NULL;
CREATE INDEX idx_book_details_condition   ON book_details(condition);

CREATE INDEX idx_clothing_details_condition ON clothing_details(condition);
CREATE INDEX idx_clothing_details_brand     ON clothing_details(brand COLLATE NOCASE);

CREATE INDEX idx_item_photos_item ON item_photos(item_id, sort_order);

CREATE INDEX idx_ip_item          ON item_platforms(item_id);
CREATE INDEX idx_ip_platform_item ON item_platforms(platform, item_id);
                                   -- "which items are listed on platform X" query pattern
