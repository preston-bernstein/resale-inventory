---
name: book-seller-architecture-contract
description: Load when working in the book-seller repo and you need the load-bearing design decisions, system invariants, or known-weak points before reading or changing code. Triggers - "how is book-seller architected", "why SQLite/better-sqlite3", "why integer cents", "status state machine", "what invariants must hold", "why does this return 500", "can I change the schema/CHECK constraints", "gross_profit", "lib/db.ts side effects", "is this behavior intentional or a bug".
---

# book-seller Architecture Contract

This skill is the contract: the design decisions this app stands on, the invariants every change must preserve, and the places the implementation is known to be weak. Read it before touching code in `/Users/prestonbernstein/dev/book-seller`.

## Orientation (60 seconds)

**What this is**: a local-first used-book inventory app for a sole seller. Next.js 15.5.19 App Router (Turbopack) UI + API routes in one project; better-sqlite3 against a single SQLite file; no auth, no cloud, no CI, zero git commits as of 2026-07-02.

**Authority chain**: `docs/book-inventory-management/` (requirements.md, plan.md, steps.md, TASKS.md, challenge-notes.md) is the change-control authority. Behavior changes require a spec update first — see the `book-seller-change-control` skill. Where spec and code conflict (see "State machine" below), code behavior is the current authority pending an owner decision; do not silently "fix" either side.

**Terms used in this skill** (defined once):

| Term | Meaning |
|---|---|
| held | a book still in inventory: `status IN ('Unlisted','Listed','Sale Pending')` |
| terminal status | `Sold`, `Removed`, `Donated`, `Discarded` — no transitions out, PATCH rejected with 409 |
| constraint leak | a SQLite CHECK-constraint violation reaching the client as HTTP 500 instead of a 422 validation error |
| spec folder | `docs/book-inventory-management/` |

## Non-negotiable safety facts

These belong to other skills for full procedure, but you must know them before running anything:

1. **`data/inventory.db` is the sole copy of real inventory data.** Never delete, recreate, or write to it during investigation. Read-only inspection only:
   ```
   sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" ".schema books"
   ```
2. **Never run `npx vitest run`.** `tests/integration.test.ts` (near line 138) executes `DELETE FROM books/book_platforms/price_history` against the REAL database, because `lib/db.ts` resolves the DB path from `process.cwd()` (see design decision 2). Verified 2026-07-02. Details: `book-seller-validation-and-qa`.
3. No mutating HTTP probes (POST/PATCH/DELETE) against a dev server unless you own the consequences; port 3000 is usually taken by an unrelated Flutter app on this machine and `next dev` silently falls back to 3001 — read the dev-server output for the real port. Details: `book-seller-run-and-operate`.

## Load-bearing design decisions

Each decision traces to `docs/book-inventory-management/plan.md` ("Technology choices", "Risk areas", "Security") or `challenge-notes.md` ("Changes made"). All code citations verified 2026-07-02.

### 1. Single-file SQLite via a synchronous better-sqlite3 singleton

`lib/db.ts` opens one `better-sqlite3` connection at module load and exports it as the default export. Why (plan.md Technology choices): single-user access pattern, so synchronous zero-latency calls beat async pooling complexity; no separate DB process; `next start` is the whole deployment. Consequence: every API route does blocking synchronous DB calls — this is intentional, do not "modernize" to an async driver.

### 2. `lib/db.ts` has module-load side effects — importing it anywhere touches the real DB

The exact code (`lib/db.ts`, verified 2026-07-02):

```ts
const dbPath = path.join(process.cwd(), 'data', 'inventory.db');   // line 5
fs.mkdirSync(path.dirname(dbPath), { recursive: true });           // line 8
const db = new Database(dbPath);                                   // line 11
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const migrationSql = fs.readFileSync(
  path.join(process.cwd(), 'data', 'migrations', '001_init.sql'), 'utf-8');
db.exec(migrationSql);                                             // line 22
```

Merely importing `@/lib/db` — from a route, a test, a script — creates `data/` if missing, opens (or creates) `inventory.db` at whatever `process.cwd()` is, and applies the migration. This is why the test suite wipes real data and why running any tool from the wrong directory creates a stray empty DB. The migration is idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` throughout `data/migrations/001_init.sql`); there is no migration version table.

### 3. WAL mode + `foreign_keys = ON` on every connection

Trace: challenge-notes "Changes made" — without WAL, Next.js App Router's concurrent async handlers hit `SQLITE_BUSY` under any parallel request load. `foreign_keys = ON` makes the `REFERENCES books(id)` clauses in `book_platforms` and `price_history` actually enforce. Both pragmas run before the migration. Confirmed live: `PRAGMA journal_mode` on the real DB returns `wal` (2026-07-02).

### 4. Money is integer cents everywhere in DB and API

Trace: plan.md Approach — "monetary values are stored as integer cents and converted only at display/input boundaries, eliminating floating-point drift entirely." `acquisition_cost`, `listing_price`, `sale_price` are `INTEGER` cents. `lib/money.ts` is the only sanctioned converter: `centsToUSD(n): string` and `usdToCents(s)` — string arithmetic (splits on `.`, never floats), half-up rounding on the third fractional digit, throws on negative/non-numeric/over 100,000,000 cents ($1M). API routes accept and return cents as numbers; only the UI and CSV columns (`*_usd`) use decimal USD. Never introduce a float or a `parseFloat`-based conversion.

### 5. `gross_profit` is computed, never stored — because storing it once caused a real bug

Trace: challenge-notes "Changes made" — the original design had a stored `gross_profit INTEGER` column; Step 9 of the implementation divided by 100 before storing, truncating small values to 0. The column was removed. It is now computed in SQL in every SELECT that returns it, e.g. (`app/api/books/route.ts` line 187):

```sql
CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END as gross_profit
```

If you ever see a proposal to store gross_profit "for performance", cite this incident and refuse via change control.

### 6. Multi-platform listings live in a `book_platforms` junction table

Trace: challenge-notes "Changes made" — originally a comma-separated `platforms TEXT` column; replaced with `book_platforms(id, book_id, platform, listed_at)` with FK + `idx_bp_book` index, because comma-separated storage made multi-platform listing an untyped silent assumption. The API still presents platforms as a `string[]`, assembled via `GROUP_CONCAT(bp.platform, ',')` in the read queries — the comma is a serialization detail at the API boundary, not the storage model. PATCH replaces the full set (DELETE then re-INSERT inside the transaction, `app/api/books/[id]/route.ts` lines 124–132).

### 7. UUIDv4 primary keys

Trace: plan.md Technology choices — collision-free IDs with no DB sequence dependency. `books` and import rows use `uuid`'s `v4()`; the PATCH route uses `crypto.randomUUID()` for `price_history` / `book_platforms` rows (`app/api/books/[id]/route.ts` lines 113, 130). Both produce UUIDv4; the inconsistency is cosmetic but real.

### 8. Enums are inline CHECK constraints — extending them means a full table rebuild

`condition` and `status` vocabularies, date shapes, and the conditional NOT NULL rules are inline `CHECK` constraints on `books` (see `data/migrations/001_init.sql`). Trace: plan.md Risk 7 — SQLite cannot ALTER a CHECK; adding a condition grade or status requires create-new-table / copy / drop / rename. Budget for that before agreeing to "just add a status". The full CHECK list: condition enum, status enum, `acquisition_date`/`sale_date` LIKE `____-__-__`, `created_at`/`updated_at` LIKE `____-__-__%`, `listing_price NOT NULL` when status is Listed/Sale Pending, and `sale_price`/`sale_date`/`sale_platform NOT NULL` when Sold.

### 9. Status state machine centralized in `lib/transitions.ts`, asserted inside the DB transaction

`ALLOWED_TRANSITIONS` (verified against `lib/transitions.ts`, 2026-07-02):

| From | Allowed to |
|---|---|
| Unlisted | Listed, Donated, Discarded |
| Listed | Unlisted, Sale Pending, Removed, Donated, Discarded |
| Sale Pending | Listed, Sold |
| Sold / Removed / Donated / Discarded | (terminal — nothing) |

`Listed → Sold` is NOT allowed; a sale is a two-step flow through Sale Pending. `assertTransitionAllowed(from, to)` throws on anything else, and the status route calls it *inside* `db.transaction()` (plan.md Risk 5: the re-read of current status and the assert must be atomic with the UPDATE — do not move the assert outside the transaction).

**Unresolved spec contradiction** (challenge-notes "Open questions"): AC3 in requirements.md implies a direct `Listed → Sold`; FR10 and the code enforce two-step; requirements.md was never reconciled. **Code behavior (two-step) is the current authority pending an owner decision.** Do not change either side without going through `book-seller-change-control`.

## Invariants

Every change must leave these true. Run verify commands from anywhere; they are self-contained.

| # | Invariant | Where enforced | How to verify (one command) |
|---|---|---|---|
| 1 | All money crosses the DB/API boundary as integer cents; conversion only via `lib/money.ts` | `lib/money.ts`; `Number.isInteger` + 0..100,000,000 bounds checks in `app/api/books/route.ts`, `app/api/books/[id]/route.ts`, `app/api/books/[id]/status/route.ts` | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT name,type FROM pragma_table_info('books') WHERE name IN ('acquisition_cost','listing_price','sale_price');"` — all `INTEGER` |
| 2 | Status changes only via `assertTransitionAllowed` called inside `db.transaction()` | `lib/transitions.ts`; call site `app/api/books/[id]/status/route.ts` line 67 | `cd /Users/prestonbernstein/dev/book-seller && grep -n "assertTransitionAllowed" "app/api/books/[id]/status/route.ts" lib/transitions.ts` |
| 3 | Sale fields (`sale_price`, `sale_date`, `sale_platform`) immutable after Sold; PATCH rejects all terminal statuses with 409 | `TERMINAL` guard in `app/api/books/[id]/route.ts` lines 55–58; DB CHECKs require sale fields NOT NULL when Sold | `cd /Users/prestonbernstein/dev/book-seller && grep -n "TERMINAL" "app/api/books/[id]/route.ts"` |
| 4 | "held" means exactly `status IN ('Unlisted','Listed','Sale Pending')` | `HELD_STATUSES` const, `app/api/dashboard/route.ts` line 4 | `cd /Users/prestonbernstein/dev/book-seller && grep -n "HELD_STATUSES" app/api/dashboard/route.ts` |
| 5 | `listing_price` required whenever status is Listed or Sale Pending | DB CHECK only (`001_init.sql` line 24) — **not** validated at the API layer; this gap is Defect 1 below | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" ".schema books" \| grep -A1 "NOT IN"` |
| 6 | ISBN stored normalized to ISBN-13; at most one book per ISBN (partial unique index) | `normalizeISBN` in `lib/isbn.ts` called by POST `/api/books`; index `idx_books_isbn ON books(isbn) WHERE isbn IS NOT NULL` — **import route violates the normalization intent** (Defect 2 below) | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT sql FROM sqlite_master WHERE name='idx_books_isbn';"` |
| 7 | `gross_profit` never stored — computed as `sale_price - acquisition_cost` in SELECTs, NULL unless Sold | read queries in books/[id]/export routes; no column exists | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT name FROM pragma_table_info('books') WHERE name='gross_profit';"` — empty output |
| 8 | WAL journal + FK enforcement on every connection | `lib/db.ts` pragmas, lines 14–15 | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "PRAGMA journal_mode;"` → `wal` |

## Known-weak points

All statuses OPEN as of 2026-07-02. State them plainly when relevant; route action to the named sibling skill. Evidence and history for all of these: `book-seller-failure-archaeology`.

**W1 — Constraint-leak HTTP 500 cluster (the hardest live problem — assumption ratified by coordinator).**
Verified Defect 1: `POST /api/books/:id/status {"status":"Listed"}` on an Unlisted book with no `listing_price` → HTTP 500 `{"error":"Internal server error."}` — the DB CHECK (invariant 5) fires and leaks; spec requires 422. Verified Defect 2: `POST /api/import` with a duplicate ISBN (in-file or vs DB) → HTTP 500 and **0 rows imported including valid ones** — the unique-index throw aborts the single transaction; violates FR22/AC9. Root cause: `app/api/import/route.ts` skips `normalizeISBN` and the duplicate pre-check that POST `/api/books` performs (it only strips non-alphanumerics, line 137). Suspected (unverified): `PATCH listing_price: null` on a Listed item hits the same CHECK → 500. Fix work: `book-seller-constraint-leak-campaign`.

**W2 — DB-wiping test suite.** `npx vitest run` deletes all inventory rows in the real DB (see safety facts). 139 passed / 15 skipped when last run 2026-07-02; only test residue was present, so no known real-data loss yet — but the trap is armed and there is no backup net (W4). Safe testing procedure: `book-seller-validation-and-qa`.

**W3 — Missing CSRF middleware.** plan.md Security requires an Origin check in Next.js middleware for POST/PATCH; no `middleware.ts` exists anywhere in the repo (verified 2026-07-02). Spec-vs-code drift, not a spec change — fix via `book-seller-change-control`.

**W4 — No backup routine.** plan.md Risk 6 specifies startup copies to `data/backups/inventory-YYYYMMDD.db` (keep 7); `data/backups/` exists and is empty (2026-07-02). The DB file is the sole copy of the data. Operational mitigation: `book-seller-run-and-operate`.

**W5 — `lib/types.ts` is a stub.** File contains only `// stub`; each route re-declares its own shapes. Any shared-types refactor lands here.

**W6 — Export builds the full CSV in memory.** `app/api/export/route.ts` uses `Papa.unparse` on the whole dataset (line 52); plan.md says streaming. Fine at current scale (1 book in DB, 2026-07-02); a known scalability lie in the spec's own terms.

**W7 — cwd-dependent DB path.** Design decision 2's flip side: run anything that imports `lib/db.ts` from the wrong directory and you silently get a fresh empty DB there. Environment discipline: `book-seller-build-and-env` and `book-seller-run-and-operate`.

**W8 — Constants duplicated.** `VALID_CONDITIONS` in 3 route files + the migration CHECK; the ISBN pattern in `lib/isbn.ts` and `app/api/isbn/[isbn]/route.ts`; the `YYYY-MM-DD` date regex in 3 files (named `DATE_RE` in two, inline in `app/api/import/route.ts`). Drift between copies is a live risk. Full inventory and change procedure: `book-seller-config-and-constants`.

**Other recorded spec-vs-code drift** (details in `book-seller-failure-archaeology`): `GET /api/isbn/:isbn` returns 404 on timeout where plan says 503; `dev` script lacks `-H 127.0.0.1` (plan Security says bind localhost); PATCH writes `price_history.previous_price = 0` instead of NULL when the price was previously unset (`app/api/books/[id]/route.ts` line 113, schema forbids NULL there — a data-fidelity smell, not a crash).

## When NOT to use this skill

| You actually need | Go to |
|---|---|
| To classify/approve a change, or the non-negotiable gates | `book-seller-change-control` |
| Symptom → cause triage for a live bug | `book-seller-debugging-playbook` |
| The evidence trail for a past defect or drift item | `book-seller-failure-archaeology` |
| ISBN math, condition grades, money/CSV theory | `bookselling-domain-reference` |
| Installing, building, environment traps | `book-seller-build-and-env` |
| Running the app, DB file care, backups, import/export ops | `book-seller-run-and-operate` |
| A specific constant's value/home/how to change it | `book-seller-config-and-constants` |
| Running or writing tests safely | `book-seller-validation-and-qa` |
| Measurement scripts and interpreting their output | `book-seller-diagnostics-and-tooling` |
| Spec templates, docs of record, house style | `book-seller-docs-and-writing` |
| Executing the fix for the 500 cluster | `book-seller-constraint-leak-campaign` |
| Open problems / external positioning | `book-seller-research-frontier` |
| Proof recipes and research discipline | `book-seller-analysis-and-methodology` |

## Provenance and maintenance

Authored 2026-07-02 from direct inspection of the repo (all cited files read; DB inspected read-only; defects 1–2 verified live by the principal engineer 2026-07-02). Coordinator-approved assumptions labeled inline; everything else is verified fact as of that date.

Volatile facts and one-line re-verification:

| Fact (as of 2026-07-02) | Re-verify with |
|---|---|
| Zero git commits on `main` | `cd /Users/prestonbernstein/dev/book-seller && git log --oneline 2>&1 \| head -1` |
| No `middleware.ts` (W3) | `cd /Users/prestonbernstein/dev/book-seller && ls middleware.ts app/middleware.ts 2>&1` |
| `data/backups/` empty (W4) | `ls /Users/prestonbernstein/dev/book-seller/data/backups` |
| `lib/types.ts` still a stub (W5) | `cat /Users/prestonbernstein/dev/book-seller/lib/types.ts` |
| Transition table unchanged | `cat /Users/prestonbernstein/dev/book-seller/lib/transitions.ts` |
| Live schema matches `001_init.sql` | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" ".schema books"` vs `data/migrations/001_init.sql` |
| Import route still skips normalizeISBN (W1/Defect 2) | `cd /Users/prestonbernstein/dev/book-seller && grep -n "normalizeISBN" app/api/import/route.ts` (no match = defect still open) |
| Versions: next 15.5.19, better-sqlite3 ^12.11.1, vitest ^4.1.9 | `cd /Users/prestonbernstein/dev/book-seller && grep -E '"(next\|better-sqlite3\|vitest)"' package.json` |
| AC3 vs FR10 contradiction still unresolved | `grep -n "AC3" /Users/prestonbernstein/dev/book-seller/docs/book-inventory-management/challenge-notes.md` |

If any re-verification diverges, update this file in the same change that lands the divergence — this skill is part of the contract surface, not documentation-after-the-fact.
