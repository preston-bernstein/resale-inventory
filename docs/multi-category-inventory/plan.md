# Plan: Multi-Category Inventory (Clothing)

## Approach

Split the single `books` table into a category-agnostic `items` base table plus per-category satellite tables (`book_details`, `clothing_details`), following the base+satellite pattern recommended in `docs/reseller-architecture-research.md` §5 (Option C) over nullable-column or EAV alternatives. With only two categories, the alternative (one shared table with every category's columns nullable) isn't combinatorial — it's linear — but it still means every category's fields pile onto one ever-widening shared table, and per-category `condition` CHECK enums either collide on that one table or get bolted on awkwardly. The satellite pattern avoids repeatedly rebuilding that single shared table as categories are added, and keeps each category's CHECK constraints — including its own `condition` vocabulary — independent and simple to reason about. All category-agnostic invariants (money as integer cents, UUIDv4 PKs, WAL+FK pragmas, the `lib/transitions.ts` state machine, `gross_profit` computed-never-stored) move to `items` completely unchanged; category-specific fields, their CHECK constraints, and their condition vocabularies live only on the satellite tables. Because SQLite cannot ALTER a CHECK constraint, this ships as a single table-rebuild migration (`003_multi_category.sql`) following this repo's existing DR-7 precedent (`data/migrations/002_price_history_nullable.sql`), driven by a `PRAGMA user_version` versioned-runner extension to `lib/db.ts` that already has one entry (version 2) and gains a second (version 3).

Adding a future third category is **mostly** additive, not fully — this caveat matters enough to state plainly rather than oversell. A new satellite table (e.g. `shoe_details`) needs no change to `items`, `book_details`, or `clothing_details` (per requirements FR21). The one exception is `items.category CHECK (category IN ('book','clothing'))`: SQLite can't ALTER a CHECK constraint, so widening that value set to admit a third category still requires one bounded rebuild of `items` alone (the same copy-archive-rename mechanics this migration uses). That rebuild is real cost, not zero — but it's strictly smaller than today's rebuild: it touches one table with no category-specific columns to preserve, not the single ever-widening shared table the satellite pattern was chosen to avoid in the first place. Satellite tables are additive; the `items.category` CHECK is the one recurring, bounded exception.

## Architecture

```
Browser (Next.js pages)
  │
  ├── /                         — dashboard: combined totals + per-category breakdown
  ├── /inventory                — searchable list, category filter (book | clothing)
  ├── /inventory/new            — category picker → book form (ISBN lookup) or clothing form (manual)
  ├── /inventory/[id]           — item detail; renders book_details or clothing_details block by category;
  │                                photo gallery + reorder/delete when category = clothing
  └── /import                   — CSV bulk import UI, unchanged UX, now accepts mixed-category rows

  │  fetch / form actions
  ▼
Next.js API Routes (app/api/**)
  │
  ├── GET  /api/isbn/[isbn]              → Open Library (unchanged, book-only)
  ├── POST /api/items                    → create item (category discriminates required fields), status = Unlisted
  ├── GET  /api/items                    → search (q, category, condition, status)
  ├── GET  /api/items/[id]               → item + category details + price_history + platforms + photos
  ├── PATCH /api/items/[id]              → update price / platform / category-scoped condition (allowlist; terminal-status items excluded)
  ├── POST /api/items/[id]/status        → validated transition (lib/transitions.ts, unchanged)
  ├── POST /api/items/[id]/photos        → upload photo(s) to local filesystem, append item_photos row(s)
  ├── GET  /api/items/[id]/photos/[photoId] → stream a photo's bytes, scoped to its item
  ├── PATCH /api/items/[id]/photos       → reorder (new sort_order array)
  ├── DELETE /api/items/[id]/photos/[photoId] → remove photo row + file
  ├── GET  /api/dashboard                → combined totals + by_category breakdown
  ├── GET  /api/export                   → streaming CSV, category column + both detail-column sets
  └── POST /api/import                   → multipart CSV; category-aware per-row validation
  │
  └── lib/db.ts  ──►  better-sqlite3  (data/inventory.db on local disk)
                          items
                          book_details
                          clothing_details
                          item_photos
                          item_platforms
                          price_history
```

Legacy `app/api/books/**` routes are removed in the same change (the requirements call this an extension of the existing book flow's UX shape, not a second parallel API surface); the book UI pages (`app/books/**`) are replaced by category-aware `app/inventory/**` pages that render the book-specific sub-form when category = book, preserving the exact existing book UX (FR: "no new UX pattern is introduced"). See Integration points for the explicit, verifiable deletion of `app/api/books/**` and `app/books/**` as its own action, not something that happens automatically when the new files are created alongside them.

## Data model

```sql
-- Migration 003_multi_category.sql
-- Table-rebuild migration per resale-inventory-change-control §4 and the DR-7 precedent
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
-- item) before this fix. A column rename cannot retarget a FK to a table
-- the constraint never mentioned; only a rebuild can, so this now follows
-- the same create-copy-drop-rename protocol as every other rebuilt table in
-- this migration, with the FK correctly pointed at `items(id)` from the
-- start. (The date-format CHECK on changed_at that a rebuild would make
-- easy to add is still deliberately omitted here, to keep this fix minimal
-- and scoped to the FK bug — add it whenever price_history is next touched
-- for an unrelated reason.)
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
```

`clothing_details` and `item_photos` are created empty — no clothing data exists pre-migration (AC3 onward populate them going forward). `items`, `book_details`, and `item_platforms` are populated via `INSERT...SELECT` from `books`/`book_platforms`, and those two source tables are then archived (renamed, not dropped — see above) rather than discarded. `price_history` is rebuilt via the same create-copy-drop-rename protocol (its FK now points at `items(id)` correctly — see the rebuild comment above for why a plain column rename wasn't sufficient), but keeps its original table name at the end, same as the archived tables keep their data.

**No cascading delete.** None of the satellite tables' `REFERENCES items(id)` foreign keys specify `ON DELETE` (SQLite's default is effectively RESTRICT under `foreign_keys=ON`), and that's intentional, not an oversight: this feature adds no `DELETE /api/items/:id` endpoint, matching the current book app, which has never had a book-delete endpoint either — status transitions to Removed/Donated/Discarded are the soft-delete mechanism. No code path ever deletes an `items` row today, so there is nothing for an `ON DELETE` clause to do.

**Legacy ISBN caveat.** `book_details.isbn` is populated as-is from `books.isbn` above, including any pre-existing ISBN-10 values. This SQL-only migration cannot call the TypeScript `normalizeISBN()` helper in `lib/isbn.ts`, so it does not attempt to re-normalize those to ISBN-13. This is a known, accepted limitation, not an oversight. Suggested (not required) follow-up: a post-migration **read-only** report — e.g. `SELECT item_id, isbn FROM book_details WHERE length(isbn) = 10` — listing normalization candidates for the operator to review. This is deliberately a report, not an auto-fix: silently normalizing risks colliding two records that look distinct today (an ISBN-10 and an ISBN-13 form of the same book, or two different books that happen to share a normalized form), which should be a manual, owner-approved reconciliation per this repo's change-control non-negotiables, not something a migration does unattended.

**`lib/db.ts` gating fix — critical integration point.** After this migration ships, `books`/`book_platforms` no longer exist under those names on a migrated DB. `lib/db.ts` currently runs `data/migrations/001_init.sql` *unconditionally* on every boot, before the versioned-migration loop even starts, and gets away with it today only because `001_init.sql` uses `CREATE TABLE IF NOT EXISTS books/book_platforms/price_history`. On the very next boot after this migration runs, that unconditional exec would silently re-create empty `books`/`book_platforms` tables via that same `IF NOT EXISTS` guard — a silent data-shape regression nothing would throw an error for. This must be fixed as part of this change: fold `001_init.sql` into the same `PRAGMA user_version`-gated loop as an implicit version-1 step, executing it only when `schemaVersion < 1`, instead of running it unconditionally before the loop starts. Full detail in "Migration mechanics precisely" below and in Integration points.

**Migration mechanics precisely, per `resale-inventory-change-control` §4:**

1. New file `data/migrations/003_multi_category.sql` (never edit `001_init.sql`'s contents directly — it stays as the fresh-install bootstrap; see item 7). Numbered `003` because `002` is already taken by `data/migrations/002_price_history_nullable.sql` (`user_version = 2`); this migration lands at `user_version = 3`.
2. `lib/db.ts` currently hardcodes running `001_init.sql` unconditionally, then loops a `VERSIONED_MIGRATIONS` array (currently `[{ version: 2, file: '002_price_history_nullable.sql' }]`) keyed off `PRAGMA user_version`. That unconditional-then-loop shape is exactly the bug this migration surfaces (see the `lib/db.ts` gating-fix note above): once `books`/`book_platforms` are archived under new names, `001_init.sql`'s `CREATE TABLE IF NOT EXISTS` would silently resurrect empty `books`/`book_platforms` tables on the very next boot. Fix: fold `001_init.sql` into the same version-gated loop as an implicit version-1 step, and extend the array with the new migration:
   ```ts
   const VERSIONED_MIGRATIONS = [
     { version: 1, file: '001_init.sql' },
     { version: 2, file: '002_price_history_nullable.sql' },
     { version: 3, file: '003_multi_category.sql' },
   ];
   ```
   A fresh DB (user_version 0) now runs all three in order inside the existing loop, landing directly on the final `items`/`book_details`/... shape with no separate unconditional pre-loop step. An existing DB already at `user_version = 2` (today's production shape) runs only `003_multi_category.sql`, exactly as before, and never touches `001_init.sql` again — closing the resurrection hole. The loop already runs each pending migration inside `db.transaction()` and bumps `user_version`; no other change to the runner's control flow is needed.
3. Idempotency: the migration runs at most once per DB because `user_version` gates it (`schemaVersion < version` check already in the loop). `003_multi_category.sql` itself is still written as a one-shot operation — do not add `IF NOT EXISTS` to its `CREATE TABLE`/`CREATE TRIGGER` statements. Unlike the original DROP-based design, accidentally re-running it against an already-migrated DB now fails loudly at the `ALTER TABLE books RENAME TO books_archived` step (table `books` no longer exists under that name) rather than silently destroying data — there's no destructive DROP left for a bug to hide behind.
4. `PRAGMA defer_foreign_keys = ON;` is the first statement inside `003_multi_category.sql`, scoped to this migration's transaction only (SQLite resets it to OFF automatically at commit/rollback). Every table is created and populated before anything that references it, so this isn't strictly load-bearing under the current statement order — but it removes the need to keep relying on that ordering staying correct if a future edit reorders these statements, making the rename/archive step's FK-safety explicit rather than incidental.
5. **Non-negotiable per change-control (g)**: before this migration ever touches `data/inventory.db`, the owner takes a manual backup first (`cp data/inventory.db{,.pre-multi-category-backup}` or an on-demand `lib/backup.ts` snapshot). The archive-don't-drop strategy (item above) gives a built-in rollback path once the migration has *run*, but it does nothing to protect against a bug in the `INSERT...SELECT` copy logic itself producing wrong data in `items`/`book_details` while the archived tables sit there correct-but-unused — so the manual backup remains required, not optional. No session runs this migration against the live DB autonomously — verify the backup exists, then let the app boot normally so the versioned-runner applies it. Recommend dry-running the migration against a copy of the live DB first and diffing row counts (`SELECT COUNT(*) FROM books` pre-migration vs `SELECT COUNT(*) FROM items WHERE category='book'` post-migration) before ever touching the real file.
6. Update this plan's Data model section (done, this document) and `plan.md`'s canonical status in the same change per §4.6 of the change-control skill.
7. `data/migrations/001_init.sql` itself is left untouched as a file — it still creates `books`/`book_platforms`/`price_history` via `CREATE TABLE IF NOT EXISTS`, which is exactly right for a genuinely fresh install (see item 2's `{ version: 1, file: '001_init.sql' }` entry). What changes is only how `lib/db.ts` invokes it: no longer unconditionally before the loop, but as the loop's version-1 step, so it never re-executes against a DB that's already past version 1 — including one that has just archived `books`/`book_platforms` out from under those names.

## API / interface contract

All API routes return `Content-Type: application/json` except `/api/export`. Monetary fields are cents (number); dates are ISO-8601 strings — unchanged conventions from the book-only API.

---

**POST /api/items**
```
Request (category=book)     { category: "book", isbn?, title, author, publisher?, condition,
                               acquisition_cost, acquisition_date }
Request (category=clothing) { category: "clothing", title, brand, size_label, color?, material?,
                               gender_department?, condition, weight_oz?, pit_to_pit_in?, length_in?,
                               sleeve_length_in?, waist_in?, rise_in?, inseam_in?, leg_opening_in?,
                               hip_in?, acquisition_cost, acquisition_date }
Response 201 { id, category, ...base fields, ...category detail fields }
Errors   409 { error: "ISBN already exists." }         — book only, normalized ISBN duplicate
         422 { error, fields[] }                        — validation failure, incl. condition
                                                            not in the item's own category vocabulary (FR7/AC4/AC5)
                                                            and negative/non-integer weight_oz (AC9)
```
Creating an item performs two inserts — into `items` and into the matching satellite table
(`book_details` or `clothing_details`) — inside a single `db.transaction()`, matching the existing
pattern already used by `POST /api/items/:id/status`. This prevents an orphaned `items` row with
no satellite row if the process crashes between the two inserts. A matching satellite row for
every `items` row is guaranteed only by this application-layer transaction discipline, not a DB
constraint — SQLite triggers can't cleanly enforce a cross-table "must have a matching row"
existence check, so this is an intentional application-layer invariant, not an oversight (see
Risk areas).

**GET /api/items**
```
Query    ?q=&category=&condition=&status=&page=&limit=
         q matches title (book: OR author) case-insensitive LIKE %q%
         category exact match: book | clothing (FR16/AC14)
         condition validated against the vocabulary for the selected category when both are present
Response 200 { items: Item[], total: number, page, limit }
         Item shape: { id, category, title, status, acquisition_cost, acquisition_date,
                        listing_price, sale_price, sale_date, sale_platform, created_at, updated_at,
                        details: BookDetails | ClothingDetails }
```

**GET /api/items/:id**
```
Response 200 { ...item, details: {...category fields}, platforms: string[],
                price_history: PriceHistory[], photos: Photo[] }
         photos: [] always present, populated only for clothing items (FR14)
         Photo shape: { id, path, sort_order } — path is a relative URL the UI can use directly
         (see GET /api/items/:id/photos/:photoId below for how the bytes themselves are served)
```

**PATCH /api/items/:id**
```
Request  { listing_price?, platforms?: string[], condition?, ...category-scoped detail fields }
         Field handling is an explicit ALLOWLIST, not a blacklist/exclusion-list: the handler
         only reads and writes the specific fields named above (plus the category-scoped detail
         fields valid for the item's own category) — it never accepts and forwards "the whole
         request body except category." A blacklist approach is one missed exclusion away from
         silently violating category immutability; the allowlist can't have that failure mode.
         category itself is never in the allowlist — immutable after creation (FR2) — and is
         additionally rejected at the DB layer by the items_category_immutable trigger (see Data
         model) if it were ever mistakenly forwarded.
Response 200 { ...updated item, details, platforms }
Errors   409  item is in a terminal status (Sold, Removed, Donated, or Discarded) — no fields
              editable. This is the "terminal-status lock"; it covers all 4 terminal statuses, not
              Sold alone — matching the existing app's current behavior. A check that only tests
              status === 'Sold' would be a regression.
         422  validation failure, incl. condition value from the wrong category's vocabulary (AC4/AC5)
         422 { error: "Cannot clear listing_price while status is Listed or Sale Pending. Transition the item first." }
```

**POST /api/items/:id/status**
```
Request  { status, sale_price?, sale_platform?, sale_date? }
Response 200 { ...updated item, details }
         gross_profit computed at read time, unchanged rule
Errors   422 { error: "Transition <from> → <to> is not permitted." }         — same lib/transitions.ts, category-blind (FR11/AC6)
         422 { error: "Cannot list an item without a listing_price. Set a price first via PATCH." }
```

**POST /api/items/:id/photos**
```
Request  multipart/form-data  files=<image[]>
         Only permitted when item.category = 'clothing'; 422 otherwise — a deliberate, considered
         product decision per requirements FR14, not an accidental side effect of validation code.
         Validation, in order:
           1. item_id path param must match the expected ID format before it's used in any file path
           2. each file's declared Content-Type AND magic bytes must indicate an image type
              (image/* plus a matching file-signature check — the declared Content-Type is never
              trusted on its own)
           3. max size per photo [threshold TBD]
           4. max photo count per item [threshold TBD]
         Stored filename is server-generated: a UUID plus an extension derived from the verified
         MIME type. The original uploaded filename is never used or trusted (path-traversal
         defense). Before writing, the route resolves the final filesystem path and asserts it
         stays under data/photos/.
Response 201 { photos: Photo[] }   — full ordered list after append, sort_order = append order (FR12/AC7)
Errors   422 { error: "Photos are not supported for category 'book'." }
         422 { error: "File is not a valid image." }              — MIME/magic-byte mismatch
         413  per-file or total upload size exceeded [threshold TBD]
```

**GET /api/items/:id/photos/:photoId**
```
Response 200  binary image stream, Content-Type derived from the stored file
         Scoped by WHERE item_id = ? AND id = ?, same as DELETE below — 404 on any mismatch
Errors   404  photo not found for this item
```
This route (or an equivalent static-file-serving mechanism, e.g. Next.js serving `data/photos/`
directly with `path` above already being a public-relative URL) is required — without some way to
load an uploaded photo's bytes, POST (upload)/PATCH (reorder)/DELETE alone give the UI no way to
render a gallery.

**PATCH /api/items/:id/photos**
```
Request  { order: string[] }        -- full ordered list of existing photo ids
Response 200 { photos: Photo[] }    -- re-sorted per requested order (FR13/AC8)
Validation, inside a single transaction before any row is written: `order` must be EXACTLY the
         item's current set of photo ids — no missing id, no extra/unknown id, no duplicate — or
         the whole request is rejected and nothing is changed.
Errors   422 { error: "order must include every existing photo id exactly once." }
```

**DELETE /api/items/:id/photos/:photoId**
```
Request  Scoped by WHERE item_id = ? AND id = ? (never photo id alone) — a photo can only be
         deleted via its own item's route; a photoId that exists but belongs to a different
         item_id returns 404, identically to a photoId that doesn't exist at all (defends against
         one item's photo being deleted via another item's route by ID guessing).
Order of operations: delete the item_photos row first, inside a transaction, then delete the file
         from disk; tolerate a missing file (ENOENT) without erroring. This mirrors, in reverse,
         the upload route's file-then-row ordering (Risk area 5): upload prefers an orphaned file
         over an orphaned DB reference, so delete removes the DB reference first, minimizing the
         window in which a row could point at a file that's already gone.
Response 200 { photos: Photo[] }    -- remaining photos, sort_order compacted (FR13/AC8)
Errors   404  photo not found for this item
```

**GET /api/dashboard**
```
Response 200 {
  held_count: number,
  held_acquisition_cost: number,
  by_condition: { [condition]: number },      -- keys drawn from both vocabularies; category-scoped in UI
  by_status:    { [status]: number },
  by_category: {                               -- new, FR17/AC13
    book:     { count: number, acquisition_cost: number },
    clothing: { count: number, acquisition_cost: number }
  }
}
```

**GET /api/export**
```
Response 200  Content-Type: text/csv
Columns: id, category, title, isbn, author, publisher,                (book-only, blank on clothing rows)
         brand, size_label, color, material, gender_department,        (clothing-only, blank on book rows)
         weight_oz, pit_to_pit_in, length_in, sleeve_length_in,
         waist_in, rise_in, inseam_in, leg_opening_in, hip_in,
         condition, acquisition_cost_usd, acquisition_date, status,
         listing_price_usd, platforms, sale_price_usd, sale_platform,
         sale_date, gross_profit_usd, created_at, updated_at            (FR18/AC11)
platforms joined from item_platforms (renamed source table), comma-separated.
```

**POST /api/import**
```
Request  multipart/form-data  file=<csv>
         Header row matches export column names; rows may mix category values (AC12)
         Book rows require: title, author, condition, acquisition_cost_usd, acquisition_date (unchanged)
         Clothing rows require: title, brand, size_label, condition, acquisition_cost_usd, acquisition_date (FR19)
Response 200 { imported: number, errors: [{ row: number, fields: string[], message: string }] }
         Missing category-required field (e.g. clothing row missing size_label) is a per-row error;
         all other valid rows in the batch still commit (FR19/AC12)
```

## Integration points

- `data/migrations/003_multi_category.sql` — new; the table-rebuild migration described above: creates `items`/`book_details`/`clothing_details`/`item_photos`/`item_platforms` and the `items_category_immutable` trigger; copies data out of `books`/`book_platforms`; archives (renames, does not drop) `books`→`books_archived` and `book_platforms`→`book_platforms_archived`; rebuilds `price_history` (create-copy-drop-rename) with its FK correctly pointed at `items(id)` — a plain `RENAME COLUMN` was tried first and found to leave the FK pointing at `books_archived` instead, since SQLite only retargets a FK to a table's *new name* when that same table is renamed, never to a different table the constraint never mentioned
- **`lib/db.ts` — gate `001_init.sql` behind the version-check loop (critical fix, not optional cleanup).** Today `001_init.sql` runs unconditionally before the `VERSIONED_MIGRATIONS` loop starts, and is safe only because it uses `CREATE TABLE IF NOT EXISTS books/book_platforms/price_history`. After `003_multi_category.sql` archives `books`/`book_platforms` under new names, that unconditional exec would silently resurrect empty `books`/`book_platforms` tables on the very next app boot via that same `IF NOT EXISTS` guard. Fix: fold `001_init.sql` into `VERSIONED_MIGRATIONS` as `{ version: 1, file: '001_init.sql' }`, ahead of `{ version: 2, file: '002_price_history_nullable.sql' }` and the new `{ version: 3, file: '003_multi_category.sql' }`, so it only ever executes against a DB at `schemaVersion < 1` (i.e. genuinely fresh). See Data model for the full rationale.
- `lib/transitions.ts` — unchanged; `assertTransitionAllowed` remains category-blind per FR11, called the same way from `app/api/items/[id]/status/route.ts`
- `lib/money.ts` — unchanged; reused as-is for all cents conversions on clothing fields
- `lib/constants.ts` — add `CLOTHING_CONDITIONS = ['NWT','NWOT','EUC','GUC','Fair']` alongside the existing `BOOK_CONDITIONS` (renamed from `VALID_CONDITIONS`); add `CATEGORIES = ['book','clothing']` and a `conditionsForCategory(category)` helper so routes validate condition against the right vocabulary in one place (FR7/AC4/AC5)
- `lib/clothing.ts` — new; clothing-specific validation helpers (`validateWeightOz`, measurement field allowlist) mirroring the shape of `lib/isbn.ts` for books
- `lib/types.ts` — still a stub (pre-existing); if populated in this change, the `Item` type should be an explicit **discriminated union** keyed on `category` — `{ category: 'book'; details: BookDetails } | { category: 'clothing'; details: ClothingDetails }` — not a loose `BookDetails | ClothingDetails` union, so TypeScript narrows automatically instead of every call site needing manual type guards; also add `Photo` shape
- `app/api/items/route.ts` — new; replaces `app/api/books/route.ts`; POST creates an item with category-discriminated required-field validation and routes detail fields to the correct satellite insert (inside a single `db.transaction()` — see API contract); the book-category branch must port the existing ISBN normalize+lookup logic currently in `app/api/books/route.ts` (the best-effort lookup that never blocks creation on failure) — this existing feature must not be silently dropped in the rewrite; GET search adds `category` filter (FR16/AC14) and resolves `condition` filter against the selected category's vocabulary
- `app/api/items/[id]/route.ts` — new; replaces `app/api/books/[id]/route.ts`; GET joins `items` to the correct satellite table by `category`, plus `item_photos` and `item_platforms`; PATCH uses an explicit field allowlist (never a blacklist that excludes `category`), enforces the terminal-status lock (all 4 terminal statuses, not Sold alone), and routes detail-field updates to the correct satellite table (FR2)
- `app/api/items/[id]/status/route.ts` — new; replaces `app/api/books/[id]/status/route.ts`; identical transition logic, category-blind (FR11/AC6)
- `app/api/items/[id]/photos/route.ts` — new; POST (upload, clothing-only per FR14, with MIME/magic-byte validation, size/count limits, server-generated UUID filenames, and a path-containment check — see API contract) and PATCH (reorder, validated as an exact-set match before writing, in a transaction)
- `app/api/items/[id]/photos/[photoId]/route.ts` — new; GET streams the photo file; DELETE removes the DB row first (inside a transaction), then the file, tolerating a missing file (ENOENT); both routes scope every query by `WHERE item_id = ? AND id = ?`, never `id` alone (IDOR defense) — the previous draft of this plan specified only PATCH/DELETE with no way to load photo bytes into the UI, which the added GET fixes
- `app/api/dashboard/route.ts` — add `by_category` aggregation (GROUP BY category) alongside existing combined totals (FR17/AC13)
- `app/api/export/route.ts` — join both satellite tables (LEFT JOIN, category-conditional), add `category` column and all clothing columns, leave the non-matching category's columns blank per row (FR18/AC11); rename `book_platforms` reference to `item_platforms`
- `app/api/import/route.ts` — category-aware per-row required-field validation (FR19/AC12); routes each valid row's insert to `items` + the correct satellite table inside the existing single-transaction batch-insert
- `app/api/isbn/[isbn]/route.ts` — unchanged; book-only lookup, no clothing analog (out of scope)
- `app/api/books/**` and `app/books/**` — **DELETED.** This is a distinct, verifiable action, not something that happens automatically once the new `app/api/items/**`/`app/inventory/**` files exist alongside them — confirm both directory trees no longer exist as part of this change, not just that new routes were added. (`app/api/books/**`: `book_platforms`'s rename to `item_platforms` means every old route referencing it must move or die; deleting avoids maintaining two parallel API surfaces for one category.)
- `app/inventory/page.tsx` — new; replaces `app/books/page.tsx`; searchable list with category filter control added to the existing filter bar
- `app/inventory/new/page.tsx` — new; replaces `app/books/add/page.tsx`; category picker at top, then renders `AddBookForm` or `AddClothingForm` (FR8, "no ISBN-style lookup step" for clothing)
- `app/inventory/[id]/page.tsx` — new; replaces `app/books/[id]/page.tsx`; renders category-specific detail block; photo gallery + reorder/delete UI only when category = clothing (FR10/AC10)
- `app/inventory/layout.tsx` — new; replaces `app/books/layout.tsx`
- `components/AddClothingForm.tsx` — new; brand/size_label/color/material/condition/weight_oz/measurements/acquisition fields, no ISBN lookup (FR8)
- `components/PhotoUpload.tsx` — new; multi-file upload + drag-to-reorder + delete control, used only from the clothing detail/add flow (FR12/13/14/AC7/AC8/AC10)
- `components/AddBookForm.tsx` — unchanged logic; only its container route moves (`app/books/add` → `app/inventory/new`)
- `components/BookTable.tsx` → `components/ItemTable.tsx` — renamed/extended; adds a category column and renders category-appropriate condition value
- `components/BookSearch.tsx` → `components/ItemSearch.tsx` — renamed/extended; adds category filter control; its current direct `CONDITIONS` import must switch to `conditionsForCategory(selectedCategory)` from `lib/constants.ts` — otherwise the condition dropdown silently keeps showing only book conditions when clothing is selected (FR16/AC14)
- `components/Dashboard.tsx` — extend to render the new `by_category` breakdown block (FR17/AC13); like `ItemSearch.tsx`, its current direct `CONDITIONS` import must switch to `conditionsForCategory(...)` — otherwise the condition breakdown silently keeps showing only book conditions
- `data/photos/` — new directory; local filesystem photo storage root, one subfolder per item id; must be added alongside `data/backups/` as a persistence boundary excluded from `.gitignore` treatment that would delete it
- `.gitignore` — confirm `data/photos/` is not excluded in a way that would prevent the directory from persisting (mirror how `data/backups/.gitkeep` is currently handled)
- `lib/backup.ts` — verification note, not an expected code change: confirm it doesn't reference table names directly (it should already be table-agnostic, since it likely uses better-sqlite3's binary `db.backup()` API) and needs no change for this migration
- `docs/multi-category-inventory/requirements.md` — already written (input to this plan); no change expected here
- `lib/__tests__/clothing.test.ts` — new; unit tests for weight_oz validation and clothing condition enum enforcement
- `lib/__tests__/transitions.test.ts` — unchanged; add cases explicitly exercising a clothing-category item through the same transition table (AC6) to prove category-blindness, without changing `lib/transitions.ts` itself
- `tests/integration.test.ts` — extend with clothing-category scenarios (add, photo upload/reorder/delete, cross-category condition rejection, mixed-category CSV import/export, photo IDOR cross-item access returning 404, reorder rejecting a non-exact id set) alongside existing book scenarios; still subject to the DB-wipe trap and safe-test procedure in `resale-inventory-validation-and-qa`

## Technology choices

- No new libraries. Photo storage uses Node's built-in `fs` module writing to `data/photos/`, consistent with the existing local-filesystem-only, no-cloud-dependency convention already used for `data/inventory.db` and `data/backups/`.
- Multipart file parsing for photo upload reuses whatever mechanism `app/api/import/route.ts` already uses for CSV multipart upload (Next.js Route Handler `request.formData()`), avoiding a new dependency for something the codebase already does once.

## Risk areas

1. **Live-DB migration safety.** `data/inventory.db` is the operator's sole, real inventory copy (change-control non-negotiable (g)). This migration no longer drops `books`/`book_platforms` outright — they're renamed to `books_archived`/`book_platforms_archived` (see Data model), which gives a built-in, zero-effort rollback path for at least one release cycle without needing to restore from an external backup file. This *partially* mitigates the original risk but does not eliminate it: if the `INSERT...SELECT` copy step has a bug (e.g. a missed column mapping), the archived tables sit there correct-but-unused while `items`/`book_details` silently hold wrong data — archiving protects against the DROP destroying data, not against the copy logic being wrong in the first place. **The migration must still never be run against the live DB without an owner-approved backup taken first** (manual copy or an on-demand `lib/backup.ts` snapshot); a session must not apply this migration to `data/inventory.db` autonomously. Recommend dry-running the migration against a copy of the live DB first and diffing row counts (`SELECT COUNT(*) FROM books` pre-migration vs `SELECT COUNT(*) FROM items WHERE category='book'` post-migration) before ever touching the real file. The archived tables' actual removal is deferred to a future migration `004`, written only after the new schema has proven stable in production for at least one release cycle.

2. **`item_platforms`/`price_history` rename touches every existing query.** Every route, test, and script that currently references `book_platforms`, `book_id`, or the `books` table (all of `app/api/books/**`, `lib/__tests__/*`, `tests/integration.test.ts`) must be found and updated in the same change. Because `books`/`book_platforms` are renamed to `books_archived`/`book_platforms_archived` rather than dropped, a missed reference still fails loudly (`no such table: books`) rather than silently querying stale data under the old name — but the surface area is large (7+ route files, 4+ test files) and easy to under-count. Grep for `book_platforms`, `book_id`, `FROM books`, `JOIN books` across the repo as a completeness check before calling this done.

3. **Condition-vocabulary cross-validation is easy to get partially right.** FR7/AC4/AC5 require rejecting a clothing condition value on a book item and vice versa — this must be enforced in both POST /api/items (create) and PATCH /api/items/:id (edit), and the check must key off the item's *existing* category on PATCH (not a category value from the request body, since category is immutable). A validator that only checks "is this a valid condition string across either vocabulary" rather than "is this valid for *this item's* category" would pass AC4/AC5's negative test cases silently.

4. **Category immutability now has DB-level backup, but the API layer is still the primary enforcement.** The `items.category` CHECK only constrains the value set (`book`/`clothing`); immutability after creation is primarily enforced by the PATCH route's explicit field allowlist (never accepting `category` — see API contract), which is still an API-layer discipline that a careless future change could get wrong. What's new: the `items_category_immutable` trigger (see Data model) now provides a real DB-level guarantee as defense-in-depth — an attempted `UPDATE` that changes `category`, from any code path, now fails loudly (`RAISE(FAIL, ...)`) instead of silently succeeding. The residual risk is narrower than before: a bug can still attempt the violation, but it can no longer succeed unnoticed.

5. **Photo storage lacks the durability guarantees the DB has.** `item_photos` rows and their filesystem files can drift out of sync (a row with no file, or an orphaned file with no row) since writing the file and inserting the row aren't one atomic operation the way `db.transaction()` covers SQL writes. The two routes deliberately use opposite orderings to keep the failure mode consistent — an orphaned *file* is preferred over an orphaned *DB reference*, since a stray file on disk is harmless and cleanable, while a DB row pointing at nothing 404s or crashes a reader: upload writes the file first, then inserts the row (rolling back the file write if the insert fails); delete removes the row first, inside a transaction, then deletes the file, tolerating a missing file (`ENOENT`) without erroring. Additionally, Next.js's `request.formData()` buffers the entire multipart upload body in memory (no streaming) — this is an accepted scale ceiling appropriate for a single-user local app, the same tier of decision as the existing 10MB CSV import cap, not an oversight.

6. **Two-table insert atomicity for item creation.** Every `items` row must have a matching satellite row (`book_details` or `clothing_details`), but SQLite triggers can't cleanly enforce a cross-table "must have a matching row" existence check the way a CHECK or FK enforces column-level or single-row constraints. This invariant is guaranteed only by application-layer discipline: `POST /api/items` performs both inserts inside a single `db.transaction()`, matching the pattern `POST /api/items/:id/status` already uses (see API contract). This is an intentional application-layer invariant, not an oversight — but it means a future code path that inserts into `items` without going through this route (or that splits the transaction) could silently produce an orphaned `items` row with no satellite row, and nothing in the schema would catch it.
