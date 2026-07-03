# Plan: Book Inventory Management

## Approach

A local-first Next.js app with SQLite as the single source of truth satisfies every requirement without operational overhead: no separate database process, no cloud dependency, and a single `npm run dev` to operate. Next.js App Router provides both the UI pages and the API routes in one project, keeping the surface area small for a sole operator. All monetary values are stored as integer cents and converted only at display/input boundaries, eliminating floating-point drift entirely.

## Architecture

```
Browser (Next.js pages)
  │
  ├── /                    — dashboard: totals, counts by status/condition
  ├── /inventory           — searchable list (ISBN / title / author / condition / status)
  ├── /inventory/new       — add-book form with ISBN lookup + manual fallback
  ├── /inventory/[id]      — item detail, status transition controls, price history
  └── /import              — CSV bulk import UI with per-row error report

  │  fetch / form actions
  ▼
Next.js API Routes (app/api/**)
  │
  ├── GET  /api/isbn/[isbn]          → Open Library (3 s timeout) → {title,author,publisher}
  ├── POST /api/books                → create item, status = Unlisted
  ├── GET  /api/books                → search (q, isbn, condition, status)
  ├── GET  /api/books/[id]           → single item + price history + platforms
  ├── PATCH /api/books/[id]          → update price / platform / condition (non-Sold only)
  ├── POST /api/books/[id]/status    → validated transition; locks cost+price on → Sold
  ├── GET  /api/dashboard            → aggregate stats (held totals, counts)
  ├── GET  /api/export               → streaming CSV download
  └── POST /api/import               → multipart CSV; returns {imported, errors[]}
  │
  └── lib/db.ts  ──►  better-sqlite3  (data/inventory.db on local disk)
                          books
                          book_platforms
                          price_history
```

ISBN lookup is a thin proxy: the API route calls Open Library, enforces the 3-second timeout via `AbortController`, and returns 200 with data, 404 when not found, or 503 on timeout—the browser form stays editable in all non-200 cases.

## Data model

```sql
-- Migration 001_init.sql
-- lib/db.ts executes PRAGMA journal_mode=WAL; and PRAGMA foreign_keys=ON;
-- immediately after opening the connection, before running this migration.

CREATE TABLE IF NOT EXISTS books (
  id               TEXT    PRIMARY KEY,          -- UUIDv4
  isbn             TEXT,                         -- NULL if none; normalized to ISBN-13
  title            TEXT    NOT NULL,
  author           TEXT    NOT NULL,
  publisher        TEXT,
  condition        TEXT    NOT NULL
                   CHECK (condition IN ('Poor','Acceptable','Good','Very Good','Like New')),
  acquisition_cost INTEGER NOT NULL,             -- cents (USD)
  acquisition_date TEXT    NOT NULL              -- ISO-8601 date
                   CHECK (acquisition_date LIKE '____-__-__'),
  status           TEXT    NOT NULL DEFAULT 'Unlisted'
                   CHECK (status IN ('Unlisted','Listed','Sale Pending','Sold',
                                     'Removed','Donated','Discarded')),
  listing_price    INTEGER,                      -- cents; NULL = not priced
  sale_price       INTEGER,                      -- cents; set on → Sold, immutable after
  sale_platform    TEXT,
  sale_date        TEXT                          -- ISO-8601 date
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_isbn   ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_status        ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_condition     ON books(condition);
-- full-text search handled by LIKE queries; upgrade to FTS5 if needed at scale
CREATE INDEX IF NOT EXISTS idx_books_title         ON books(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_author        ON books(author COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_created_at    ON books(created_at);
CREATE INDEX IF NOT EXISTS idx_books_sale_date     ON books(sale_date);

CREATE TABLE IF NOT EXISTS book_platforms (
  id          TEXT    PRIMARY KEY,               -- UUIDv4
  book_id     TEXT    NOT NULL REFERENCES books(id),
  platform    TEXT    NOT NULL,
  listed_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bp_book ON book_platforms(book_id);

CREATE TABLE IF NOT EXISTS price_history (
  id             TEXT    PRIMARY KEY,            -- UUIDv4
  book_id        TEXT    NOT NULL REFERENCES books(id),
  previous_price INTEGER NOT NULL,              -- cents
  new_price      INTEGER NOT NULL,              -- cents
  changed_at     TEXT    NOT NULL               -- ISO-8601 datetime
);

CREATE INDEX IF NOT EXISTS idx_ph_book ON price_history(book_id);
```

**Status transition table** (enforced in `lib/transitions.ts`):

| From \ To      | Unlisted | Listed | Sale Pending | Sold | Removed | Donated | Discarded |
|----------------|----------|--------|--------------|------|---------|---------|-----------|
| Unlisted       | —        | ✓      |              |      |         | ✓       | ✓         |
| Listed         | ✓        | —      | ✓            |      | ✓       | ✓       | ✓         |
| Sale Pending   |          | ✓      | —            | ✓    |         |         |           |
| Sold           | ✗        | ✗      | ✗            | —    | ✗       | ✗       | ✗         |
| Removed        |          |        |              |      | —       |         |           |
| Donated        |          |        |              |      |         | —       |           |
| Discarded      |          |        |              |      |         |         | —         |

Any cell not marked ✓ is rejected with HTTP 422 and a plain-English error message.

**Money rule**: `acquisition_cost` and `sale_price` are read-only once `status = 'Sold'`. The PATCH route checks status before allowing any write; the status transition route writes `sale_price`, `sale_date`, and `sale_platform` atomically in a single transaction, then makes those columns immutable. `gross_profit` is computed at read time as `sale_price - acquisition_cost` and never stored.

## API / interface contract

All API routes return `Content-Type: application/json` except `/api/export`.
Monetary fields are returned as **number (cents)** to the API caller; the UI layer converts for display.

---

**POST /api/books**
```
Request  { isbn?, title, author, publisher?, condition, acquisition_cost, acquisition_date }
         acquisition_cost in cents; isbn normalized to ISBN-13 on server before storing
Response 201 { id, ...all fields }
Errors   409 { error: "ISBN already exists." }   — normalized ISBN duplicate
         422 { error, fields[] }                  — validation failure
```

**GET /api/books**
```
Query    ?q=&isbn=&condition=&status=&page=&limit=
         q matches title OR author (case-insensitive LIKE %q%)
Response 200 { items: Book[], total: number, page, limit }
```

**PATCH /api/books/:id**
```
Request  { listing_price?, platforms?: string[], condition? }   — all optional, any subset
Response 200 { ...updated book, platforms: string[] }
         Records price_history row if listing_price changes.
Errors   409  item is Sold — no fields editable
         422  validation failure
         422 { error: "Cannot clear listing_price while status is Listed or Sale Pending. Transition the item first." }
             — listing_price: null requested on a Listed/Sale Pending item (FR24)
```

**POST /api/books/:id/status**
```
Request  { status, sale_price?, sale_platform?, sale_date? }
         sale_* required when status = "Sold"
Response 200 { ...updated book }
Errors   422 { error: "Transition <from> → <to> is not permitted." }
         422 { error: "Cannot list a book without a listing_price. Set a price first via PATCH." }
             — target status Listed or Sale Pending and the item has no listing_price (FR23)
```

**GET /api/books/:id**
```
Response 200 { ...book, platforms: string[], price_history: PriceHistory[] }
```

**GET /api/isbn/:isbn**
```
Response 200 { title, author, publisher }
         400 { error: "Invalid ISBN format." }
         404 { error: "Not found" }
         503 { error: "Lookup timed out. Enter details manually." }
```

**GET /api/dashboard**
```
Response 200 {
  held_count: number,            -- status NOT IN ('Sold','Donated','Discarded','Removed')
  held_acquisition_cost: number, -- sum cents, same filter
  by_condition: { [condition]: number },
  by_status:    { [status]: number }
}
```

**GET /api/export**
```
Response 200  Content-Type: text/csv
              Content-Disposition: attachment; filename="inventory-<date>.csv"
Columns (in order): id, isbn, title, author, publisher, condition,
                    acquisition_cost_usd, acquisition_date, status,
                    listing_price_usd, platforms, sale_price_usd,
                    sale_platform, sale_date, gross_profit_usd, created_at, updated_at
All USD columns formatted as "0.00" strings.
gross_profit_usd computed as sale_price - acquisition_cost at query time.
platforms joined from book_platforms and serialized as comma-separated string.
```

**POST /api/import**
```
Request  multipart/form-data  file=<csv>
         CSV must have a header row matching the export column names.
         acquisition_cost_usd and listing_price_usd in decimal USD (converted to cents on ingest).
         Hard 10 MB file size limit enforced before parsing; returns 413 if exceeded.
Response 200 { imported: number, errors: [{ row: number, fields: string[], message: string }] }
         Rows with errors are skipped; all valid rows are committed in a single transaction (FR22).
         A row whose ISBN (after normalizeISBN) duplicates another row already in inventory, or
         an earlier row in the same file, is reported as a per-row error (fields: ["isbn"]) and
         skipped — it does not abort the batch and does not roll back other valid rows (FR22).
```

## Integration points

- `app/api/books/route.ts` — create book (POST) and search (GET); validates condition enum and required fields; normalizes ISBN-10 to ISBN-13; returns 409 on duplicate normalized ISBN
- `app/api/books/[id]/route.ts` — fetch single item with price history and platforms via join (GET) and field updates (PATCH); enforces Sold lock; rejects clearing listing_price while Listed/Sale Pending (FR24); updates book_platforms rows on platforms change
- `app/api/books/[id]/status/route.ts` — status transition; calls `lib/transitions.ts`; requires listing_price to be set before Listed/Sale Pending (FR23); writes `sale_price`, `sale_date`, and `sale_platform` atomically in a single transaction (gross_profit not stored)
- `app/api/isbn/[isbn]/route.ts` — validates `:isbn` format (`/^\d{9}[\dX]$|^\d{13}$/`), returns 400 on mismatch; Open Library proxy with 3-second `AbortController` timeout and 64 KB response cap
- `app/api/dashboard/route.ts` — single aggregation query; no joins needed
- `app/api/export/route.ts` — streams CSV via `Response` with readable stream; uses `papaparse` to serialize; computes gross_profit via SQL; joins book_platforms for platforms column; prefixes formula-injection characters (`=`, `+`, `-`, `@`) with tab
- `app/api/import/route.ts` — enforces 10 MB limit before parsing; parses multipart upload, validates rows (incl. `normalizeISBN` and per-row duplicate-ISBN check, in-file and vs-DB, FR22), batch-inserts valid rows in a single transaction, collects errors; all imported items created with status `Unlisted`
- `lib/db.ts` — opens `better-sqlite3` connection to `data/inventory.db`; executes `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` immediately after open, before migrations; runs migration SQL on startup; exports singleton `db`
- `lib/transitions.ts` — exports `ALLOWED_TRANSITIONS` map and `assertTransitionAllowed(from, to)` throwing on invalid
- `lib/money.ts` — `centsToUSD(n): string`, `usdToCents(s): number` with rounding guard; used at every API boundary
- `lib/isbn.ts` — `lookupISBN(isbn): Promise<{title,author,publisher}|null>` with 3-second timeout and 64 KB cap; called by the API route; `normalizeISBN(isbn): string` converts ISBN-10 to ISBN-13
- `data/migrations/001_init.sql` — schema definition applied by `lib/db.ts` at boot
- `package.json` — project metadata, dependencies, and dev-dependency setup
- `package-lock.json` — lockfile for consistent dependency versions
- `tsconfig.json` — TypeScript configuration for Next.js project
- `next.config.ts` — Next.js configuration (app router, build settings)
- `tailwind.config.ts` — Tailwind CSS configuration and theme customization
- `postcss.config.js` — PostCSS configuration for Tailwind processing
- `.gitignore` — version control exclusions (data/, node_modules, .env)
- `app/layout.tsx` — root layout with nav, footer, Tailwind structure
- `app/globals.css` — Tailwind directives (@tailwind) and global styles
- `lib/__tests__/transitions.test.ts` — unit tests for status transition validation
- `lib/__tests__/money.test.ts` — unit tests for cent/USD conversion edge cases
- `lib/__tests__/isbn.test.ts` — unit tests for ISBN lookup and timeout handling
- `app/page.tsx` — landing page with links to inventory and dashboard
- `app/books/layout.tsx` — layout wrapper for books section pages
- `app/dashboard/layout.tsx` — layout wrapper for dashboard section pages
- `app/books/add/page.tsx` — form page for adding new book with ISBN auto-populate + manual fallback
- `app/books/[id]/page.tsx` — detail page for single book with edit form, status transition, price history
- `components/AddBookForm.tsx` — reusable form component for book entry (ISBN lookup + manual fields)
- `app/books/page.tsx` — inventory listing page with searchable table and filters
- `components/BookTable.tsx` — table component displaying books with title, author, condition, status, price
- `components/BookSearch.tsx` — search/filter sidebar (ISBN, title, author, condition, status, pagination)
- `app/dashboard/page.tsx` — dashboard page with metric cards (held count, cost, condition/status breakdowns)
- `components/Dashboard.tsx` — reusable dashboard metrics component with aggregated stats
- `tests/integration.test.ts` — end-to-end test scenarios covering full lifecycle and edge cases

## Technology choices

- **Next.js 15 (App Router)** — co-locates UI and API in one project; no separate server process to manage; `next start` is the entire deployment.
- **better-sqlite3** — synchronous SQLite bindings; zero-latency for single-user access patterns; no connection pooling complexity; file survives restarts.
- **papaparse** — battle-tested CSV parser with streaming support and per-row error collection; handles BOM, quoted fields, and encoding edge cases.
- **uuid (v4)** — deterministic, collision-free internal IDs with no DB sequence dependency.
- **Open Library Books API** (`https://openlibrary.org/api/books?bibkeys=ISBN:&format=json`) — free, no API key, broad coverage; sufficient for the lookup use case.
- **Tailwind CSS** — utility-first styling; no design system to maintain; keeps the UI layer thin.
- **Vitest** — fast unit and integration test runner compatible with TypeScript and Next.js; used for `lib/__tests__/` unit tests and `tests/integration.test.ts`.

## Risk areas

1. **Open Library coverage gaps** — academic texts, self-published books, pre-1970 titles, and international editions often have thin or missing Open Library records. The degraded-mode manual path (FR 3) must be the first-class UX, not an afterthought; the ISBN field should never block form submission.

2. **Money conversion boundary bugs** — every place that reads user input (forms, CSV import) must convert decimal USD → cents before writing; every place that renders (UI, CSV export) must convert cents → USD string. A single missed conversion silently corrupts data. Centralize all conversions in `lib/money.ts` and add unit tests covering edge cases (e.g., "9.999" rounding, empty string, non-numeric input).

3. **CSV import schema fragility** — spreadsheet applications add BOMs, silently reformat dates and currency columns, and may reorder or rename headers on re-export. The import validator must be lenient about whitespace and BOM but strict about required field presence; error messages must name the exact column and row so the operator can fix the file without guessing.

4. **SQLite file path in deployment** — if the app is ever moved to a platform with an ephemeral filesystem (e.g., Vercel), `data/inventory.db` is silently wiped on each deploy. The `data/` directory must be documented as the sole persistence boundary, kept out of `.gitignore` (or backed up explicitly), and never placed under `/tmp`. A startup check that logs the resolved absolute path will surface misconfiguration early.

5. **Status transition enforcement at the API layer** — the UI can enforce transitions visually, but the constraint must also be enforced in the API route (and tested directly via HTTP) to prevent an operator from accidentally replaying a stale form or browser back-button submission that bypasses the UI guards. The `assertTransitionAllowed` helper must be called inside the database transaction, not before it.

6. **Data backup** — `data/inventory.db` is the sole copy of all inventory data. Implement a startup routine that copies `data/inventory.db` to `data/backups/inventory-YYYYMMDD.db` (keeping last 7 copies) to protect against accidental deletion or corruption.

7. **Status/condition enum extension** — SQLite inline CHECK constraints require a full table rebuild to extend. If the condition grading scale or status vocabulary must grow, this requires careful migration planning: create new table, copy data, drop old table, rename. Document this cost before shipping v1.

8. **CSV import field behavior** — The import schema accepts all export columns but only `title`, `author`, `condition`, `acquisition_cost_usd`, and `acquisition_date` are required. Sale-related fields (`sale_price_usd`, `sale_platform`, `sale_date`) are ignored on import — all imported items are created with status `Unlisted` regardless of any status column in the CSV. Document this in the import UI.

## Security

- **Bind to localhost**: In development and production (when run locally), bind Next.js to `127.0.0.1` only (`next dev -H 127.0.0.1`). Document this in README.
- **SQL injection**: All database queries must use better-sqlite3 prepared statements (`.prepare()` with `?` placeholders). Never interpolate user input into SQL strings.
- **ISBN validation**: Validate the `:isbn` URL parameter against `/^\d{9}[\dX]$|^\d{13}$/` before constructing the Open Library URL. Reject non-conforming values with 400.
- **Input bounds**: Enforce `q` search param max length 200 chars; `limit` query param max 200, default 25; `page` min 0. Reject out-of-range values with 400.
- **Monetary values**: Validate that `acquisition_cost`, `listing_price`, and `sale_price` are non-negative numbers before conversion to cents. Reject values < 0 or > 1,000,000 (USD) with 422.
- **CSV import file size**: Enforce a hard 10 MB file size limit on POST /api/import before parsing. Return 413 if exceeded.
- **CSV formula injection**: During export, prefix any cell value that starts with `=`, `+`, `-`, or `@` with a tab character to prevent spreadsheet formula execution.
- **CSRF protection**: Add an `Origin` header check in a Next.js middleware for all POST/PATCH routes; reject requests whose Origin does not match the app's own host.
- **Error message safety**: Known DB CHECK/unique-constraint invariants (listing_price required for Listed/Sale Pending, ISBN uniqueness) must be validated in the route *before* the write, returning a plain-English 422/409 (see API contract) — never let these surface as 500. As defense-in-depth, still catch better-sqlite3 exceptions at the route level and map by `.code`: `SQLITE_CONSTRAINT_CHECK` → 422, `SQLITE_CONSTRAINT_UNIQUE` → 409, anything else → generic `{ error: "Internal server error" }` with HTTP 500, logged server-side only. Never string-match error messages.
- **Open Library response size**: Cap the response body from Open Library at 64 KB; abort and return 503 if the response exceeds this limit.
