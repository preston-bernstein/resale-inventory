---
name: resale-inventory-architecture-contract
description: Load when working in the resale-inventory repo (formerly book-seller) and you need the load-bearing design decisions, system invariants, or known-weak points before reading or changing code. Triggers - "how is resale-inventory architected", "why SQLite/better-sqlite3", "why integer cents", "status state machine", "what invariants must hold", "why does this return 500", "can I change the schema/CHECK constraints", "gross_profit", "lib/db.ts side effects", "is this behavior intentional or a bug".
---

# resale-inventory Architecture Contract

This skill is the contract: the design decisions this app stands on, the invariants every change must preserve, and the places the implementation is known to be weak. Read it before touching code in `/Users/prestonbernstein/dev/book-seller`.

## Orientation (60 seconds)

**What this is**: a local-first used-item resale inventory app for a sole seller, covering two categories — **books** and **clothing** — added by a multi-category migration on top of the original books-only app. Next.js 15.5.19 App Router (Turbopack) UI + API routes in one project; better-sqlite3 against a single SQLite file; no auth, no cloud, no CI. The repo now has real git history and a private GitHub remote (`preston-bernstein/resale-inventory`) — the "zero commits" state was true only at the very start of the original single-category build.

**Authority chain**: two spec folders under `docs/`, applied in sequence — `docs/book-inventory-management/` (requirements.md, plan.md, steps.md, TASKS.md, challenge-notes.md) for the original books-only build, and `docs/multi-category-inventory/` (same file set) for the books+clothing migration. Both are change-control authority for the parts of the system they cover; newer decisions (multi-category schema, `app/api/items/*` routes, category-agnostic behavior) trace to the second folder. Behavior changes require a spec update first — see the `resale-inventory-change-control` skill. Where spec and code conflict (see "State machine" below), code behavior is the current authority pending an owner decision; do not silently "fix" either side.

**Terms used in this skill** (defined once):

| Term | Meaning |
|---|---|
| held | an item still in inventory, either category: `status IN ('Unlisted','Listed','Sale Pending')` |
| terminal status | `Sold`, `Removed`, `Donated`, `Discarded` — no transitions out, PATCH rejected with 409 |
| constraint leak | a SQLite CHECK-constraint violation reaching the client as HTTP 500 instead of a 422 validation error |
| spec folders | `docs/book-inventory-management/` (original) and `docs/multi-category-inventory/` (books+clothing migration) |

## Non-negotiable safety facts

These belong to other skills for full procedure, but you must know them before running anything:

1. **`data/inventory.db` is the sole copy of real inventory data.** Never delete, recreate, or write to it during investigation. Read-only inspection only. **Caveat verified live (2026-07-12):** the real file was unmigrated (`PRAGMA user_version = 0`, legacy single-category `books` schema) for most of this repo's life, but has since been migrated — a `npm run build` invocation during a documentation-audit session booted `@/lib/db` against the real file (an easy-to-miss side effect: unlike `npm test`/`npx playwright test`, `npm run build`/`dev`/`start` have no `BOOKSELLER_DB_PATH` override and always resolve to the real file). The migration ran cleanly and non-destructively — the one existing row (a "Test Book" fixture) is preserved intact under `items`/`book_details`, and the original `books`/`book_platforms` tables are kept as `books_archived`/`book_platforms_archived` rather than dropped. Current live state: `PRAGMA user_version = 3`, schema is `items`/`book_details`/`clothing_details`/`item_platforms`/`item_photos` (as described below), 1 row. Verify before trusting either shape:
   ```
   sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "PRAGMA user_version;"
   sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" ".schema items"
   ```
   **The lesson, not just the current state:** any command that imports `@/lib/db` (a real `next build`/`dev`/`start`, or a hand-rolled script) — not just test runners — can silently migrate or otherwise touch the real file. `BOOKSELLER_DB_PATH` protects `vitest.config.ts`/`playwright.config.ts`-driven runs; it protects nothing else by default.
2. **Running the test suite is safe by default now — but stay inside the committed config.** `tests/integration.test.ts` still executes a destructive `DELETE FROM item_photos; ... DELETE FROM items;` in its `beforeEach`. This used to wipe the REAL database (`lib/db.ts` resolved the path from bare `process.cwd()`). It no longer does: `vitest.config.ts` sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` in `test.env` to `.vitest-scratch/` paths, so `npm test` / `vitest run` now points every test file at a throwaway DB automatically. The rule that remains non-negotiable: never manually override `BOOKSELLER_DB_PATH` to point at the real `data/inventory.db` for a test run, and never run DB-touching test/script code through a path that bypasses `vitest.config.ts` (e.g. a hand-rolled node script that imports `@/lib/db` from the repo root with the env var unset). Details: `resale-inventory-validation-and-qa`.
3. No mutating HTTP probes (POST/PATCH/DELETE) against a dev server unless you own the consequences; read the dev-server output for the actual bound port rather than assuming 3000 is free. Details: `resale-inventory-run-and-operate`.

## Load-bearing design decisions

Each decision traces to `docs/book-inventory-management/plan.md` / `challenge-notes.md` (original build) or `docs/multi-category-inventory/plan.md` / `challenge-notes.md` (books+clothing migration). All code citations re-verified against the current repo.

### 1. Single-file SQLite via a synchronous better-sqlite3 singleton

`lib/db.ts` opens one `better-sqlite3` connection at module load and exports it as the default export. Why (plan.md Technology choices): single-user access pattern, so synchronous zero-latency calls beat async pooling complexity; no separate DB process; `next start` is the whole deployment. Consequence: every API route does blocking synchronous DB calls — this is intentional, do not "modernize" to an async driver.

### 2. `lib/db.ts` has module-load side effects — importing it anywhere touches the real DB

The exact code (`lib/db.ts`, current):

```ts
const dbPath =
  process.env.BOOKSELLER_DB_PATH ?? path.join(process.cwd(), 'data', 'inventory.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const VERSIONED_MIGRATIONS = [
  { version: 1, file: '001_init.sql' },
  { version: 2, file: '002_price_history_nullable.sql' },
  { version: 3, file: '003_multi_category.sql' },
];
const schemaVersion = db.pragma('user_version', { simple: true }) as number;
for (const { version, file } of VERSIONED_MIGRATIONS) {
  if (schemaVersion < version) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

void runStartupBackup(db, dbPath);
```

Merely importing `@/lib/db` — from a route, a test, a script — creates `data/` if missing, opens (or creates) the DB at `BOOKSELLER_DB_PATH` (or `process.cwd()`-relative `data/inventory.db` if unset), and runs any migration whose number exceeds the DB's current `PRAGMA user_version`. This is why running any tool from the wrong directory (with the env var unset) creates a stray empty DB, and why the migration is now versioned rather than idempotent-by-`IF NOT EXISTS`: it now runs at most once per version, gated by `user_version`, inside a transaction. It also fires a fire-and-forget startup backup (`lib/backup.ts`) on every boot except during `next build`.

### 3. WAL mode + `foreign_keys = ON` on every connection

Trace: original challenge-notes "Changes made" — without WAL, Next.js App Router's concurrent async handlers hit `SQLITE_BUSY` under any parallel request load. `foreign_keys = ON` makes the `REFERENCES items(id)` clauses in `book_details`, `clothing_details`, `item_platforms`, `item_photos`, and `price_history` actually enforce. Both pragmas run before any migration.

### 4. Money is integer cents everywhere in DB and API

Trace: plan.md Approach — "monetary values are stored as integer cents and converted only at display/input boundaries, eliminating floating-point drift entirely." `acquisition_cost`, `listing_price`, `sale_price` are `INTEGER` cents on the `items` table (category-agnostic — both books and clothing share these columns). `lib/money.ts` is the only sanctioned converter: `centsToUSD(n): string` and `usdToCents(s)` — string arithmetic (splits on `.`, never floats), half-up rounding on the third fractional digit, throws on negative/non-numeric/over 100,000,000 cents ($1M). API routes accept and return cents as numbers; only the UI and CSV columns (`*_usd`) use decimal USD. Never introduce a float or a `parseFloat`-based conversion.

### 5. `gross_profit` is computed, never stored — because storing it once caused a real bug

Trace: original challenge-notes "Changes made" — the original design had a stored `gross_profit INTEGER` column; an early implementation step divided by 100 before storing, truncating small values to 0. The column was removed. It is now computed in SQL wherever a route needs it, e.g. (`app/api/items/[id]/status/route.ts`, the status-transition response):

```sql
CASE WHEN i.status = 'Sold' THEN (i.sale_price - i.acquisition_cost) ELSE NULL END as gross_profit
```

and (`app/api/export/route.ts`, the CSV export):

```sql
CASE WHEN i.status = 'Sold' THEN (i.sale_price - i.acquisition_cost) ELSE NULL END AS gross_profit_cents
```

Note this is narrower than it used to be: the list endpoint (`GET /api/items`) and the item-detail endpoint (`GET /api/items/[id]`) do **not** compute `gross_profit` in their SELECTs — only the status-transition response and the CSV export do. There is no `gross_profit` column anywhere. If you ever see a proposal to store gross_profit "for performance", cite this incident and refuse via change control.

### 6. Multi-platform listings live in an `item_platforms` junction table

Trace: original challenge-notes "Changes made" — originally a comma-separated `platforms TEXT` column; replaced with a junction table, because comma-separated storage made multi-platform listing an untyped silent assumption. The multi-category migration (`003_multi_category.sql`) rebuilt this table as `item_platforms(id, item_id, platform, listed_at)` — `item_id` in place of the old `book_id`, plus a `UNIQUE(item_id, platform)` constraint that didn't exist before — and archived the original `book_platforms` table as `book_platforms_archived` (dead, unused by any route). The API still presents platforms as a `string[]`, assembled via `GROUP_CONCAT(ip.platform, ',')` in the read queries — the comma is a serialization detail at the API boundary, not the storage model. PATCH replaces the full set (DELETE then re-INSERT inside the transaction, `applyPlatformsReplace()` in `app/api/items/[id]/route.ts`).

### 7. UUIDv4 primary keys

Trace: plan.md Technology choices — collision-free IDs with no DB sequence dependency. `items` rows (both create paths and import rows) use `uuid`'s `v4()`; the PATCH route and the status route use `crypto.randomUUID()` for `price_history` / `item_platforms` rows. Both produce UUIDv4; the inconsistency is cosmetic but real.

### 8. Enums are inline CHECK constraints — extending them means a full table rebuild

`status` vocabulary, date shapes, and the conditional NOT NULL rules are inline `CHECK` constraints on `items`; `condition` moved off the base table entirely in the multi-category migration and is now two independent per-category `CHECK` constraints — one on `book_details.condition` (unchanged 5-value vocabulary) and one on `clothing_details.condition` (new: NWT/NWOT/EUC/GUC/Fair) — see `data/migrations/003_multi_category.sql`. Trace: plan.md Risk 7 (original) — SQLite cannot ALTER a CHECK; adding a condition grade or status requires create-new-table / copy / drop / rename, and the multi-category migration itself is the worked example of that protocol (it also archived, rather than dropped, the superseded `books`/`book_platforms` tables — see the migration's own header comment for the rollback rationale). Budget for that before agreeing to "just add a status". The current CHECK list on `items`: category enum (`book`/`clothing`, also defended by an `items_category_immutable` trigger), status enum, `acquisition_date`/`sale_date` LIKE `____-__-__`, `created_at`/`updated_at` LIKE `____-__-__%`, non-negativity on `acquisition_cost`/`listing_price`/`sale_price`, `listing_price NOT NULL` when status is Listed/Sale Pending, and `sale_price`/`sale_date`/`sale_platform NOT NULL` when Sold.

### 9. Status state machine centralized in `lib/transitions.ts`, asserted inside the DB transaction

`ALLOWED_TRANSITIONS` (verified against `lib/transitions.ts`, current — unchanged by the multi-category migration; still category-agnostic and applies identically to book and clothing items):

| From | Allowed to |
|---|---|
| Unlisted | Listed, Donated, Discarded |
| Listed | Unlisted, Sale Pending, Removed, Donated, Discarded |
| Sale Pending | Listed, Sold |
| Sold / Removed / Donated / Discarded | (terminal — nothing) |

`Listed → Sold` is NOT allowed; a sale is a two-step flow through Sale Pending. `assertTransitionAllowed(from, to)` throws on anything else, and the status route calls it *inside* `db.transaction()` (plan.md Risk 5: the re-read of current status and the assert must be atomic with the UPDATE — do not move the assert outside the transaction).

**Unresolved spec contradiction** (original challenge-notes "Open questions"): AC3 in `docs/book-inventory-management/requirements.md` implies a direct `Listed → Sold`; FR10 and the code enforce two-step; requirements.md was never reconciled, and the multi-category migration did not touch this. **Code behavior (two-step) is the current authority pending an owner decision.** Do not change either side without going through `resale-inventory-change-control`.

## Invariants

Every change must leave these true. Run verify commands from anywhere; they are self-contained. The commands below query `items`/`book_details`/etc. — verified live: the real `data/inventory.db` is migrated (`PRAGMA user_version = 3`, see safety fact 1 above), so these will resolve against it directly. If you ever find it back at `user_version = 0` (schema drift, a restore from an old backup, etc.), point verify commands at a scratch DB instead (e.g. `.vitest-scratch/inventory.db` after a test run) rather than assuming the live shape.

| # | Invariant | Where enforced | How to verify (one command) |
|---|---|---|---|
| 1 | All money crosses the DB/API boundary as integer cents; conversion only via `lib/money.ts` | `lib/money.ts`; `Number.isInteger` + 0..100,000,000 bounds checks in `app/api/items/route.ts`, `app/api/items/[id]/route.ts`, `app/api/items/[id]/status/route.ts` | `sqlite3 "file:.vitest-scratch/inventory.db?mode=ro" "SELECT name,type FROM pragma_table_info('items') WHERE name IN ('acquisition_cost','listing_price','sale_price');"` — all `INTEGER` |
| 2 | Status changes only via `assertTransitionAllowed` called inside `db.transaction()` | `lib/transitions.ts`; call site `app/api/items/[id]/status/route.ts` | `cd /Users/prestonbernstein/dev/book-seller && grep -n "assertTransitionAllowed" "app/api/items/[id]/status/route.ts" lib/transitions.ts` |
| 3 | Sale fields (`sale_price`, `sale_date`, `sale_platform`) immutable after Sold; PATCH rejects all terminal statuses with 409 | `TERMINAL` guard in `app/api/items/[id]/route.ts`; DB CHECKs require sale fields NOT NULL when Sold | `cd /Users/prestonbernstein/dev/book-seller && grep -n "TERMINAL" "app/api/items/[id]/route.ts"` |
| 4 | "held" means exactly `status IN ('Unlisted','Listed','Sale Pending')`, across both categories | `HELD_STATUSES` const, `lib/dashboard.ts` (NOT `app/api/dashboard/route.ts`, which is now a thin wrapper) | `cd /Users/prestonbernstein/dev/book-seller && grep -n "HELD_STATUSES" lib/dashboard.ts` |
| 5 | `listing_price` required whenever status is Listed or Sale Pending | DB CHECK on `items` (`data/migrations/003_multi_category.sql`) AND, since the original Defect 1 fix, an explicit API-layer check in `app/api/items/[id]/status/route.ts` (`missingListingPrice` → 422 "Cannot list an item without a listing_price") — this used to be DB-CHECK-only (constraint-leak defect), now double-enforced | `cd /Users/prestonbernstein/dev/book-seller && grep -n "missingListingPrice" "app/api/items/[id]/status/route.ts"` |
| 6 | ISBN stored normalized to ISBN-13; at most one book per ISBN (partial unique index) | `normalizeISBN` in `lib/isbn.ts` called by POST `/api/items` (book branch); index `idx_book_details_isbn ON book_details(isbn) WHERE isbn IS NOT NULL` — import route now normalizes AND checks duplicates per-row (original Defect 2 is fixed, see W1 below) | `sqlite3 "file:.vitest-scratch/inventory.db?mode=ro" "SELECT sql FROM sqlite_master WHERE name='idx_book_details_isbn';"` |
| 7 | `gross_profit` never stored — computed as `sale_price - acquisition_cost` only where a route needs it (status-transition response, CSV export), NULL unless Sold | `app/api/items/[id]/status/route.ts`, `app/api/export/route.ts`; no column exists on any table | `sqlite3 "file:.vitest-scratch/inventory.db?mode=ro" "SELECT name FROM pragma_table_info('items') WHERE name='gross_profit';"` — empty output |
| 8 | WAL journal + FK enforcement on every connection | `lib/db.ts` pragmas | `sqlite3 "file:.vitest-scratch/inventory.db?mode=ro" "PRAGMA journal_mode;"` → `wal` |
| 9 | `category` is immutable after item creation | DB trigger `items_category_immutable` (`003_multi_category.sql`) + PATCH route's field allowlist never includes `category` (defense in depth) | `cd /Users/prestonbernstein/dev/book-seller && grep -n "items_category_immutable" data/migrations/003_multi_category.sql` |

## Known-weak points

State them plainly when relevant; route action to the named sibling skill. Evidence and history for all of these: `resale-inventory-failure-archaeology`. Status markers below were re-verified against the current codebase, not just carried forward.

**W1 — Constraint-leak HTTP 500 cluster.** FIXED (originally D1/D2/D3 in failure-archaeology). All three now return 4xx (422/409) with defense-in-depth SqliteError `.code` mapping instead of leaking a bare 500 — confirmed still true in `app/api/items/route.ts`/`app/api/items/[id]/route.ts` (`mapPatchDbError`) and `app/api/import/route.ts` (`mapImportDbError`), which now also does a per-row duplicate-ISBN check (`buildBookRow` in `app/api/import/route.ts`) rather than aborting the whole import. Details/regression evidence: `resale-inventory-constraint-leak-campaign`, `resale-inventory-failure-archaeology`.

**W2 — DB-wiping test suite.** FIXED (upgraded from the prior MITIGATED status). `lib/db.ts` resolves its path via `process.env.BOOKSELLER_DB_PATH ?? cwd default`, and — this is the part that was previously missing — `vitest.config.ts` now sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` in `test.env` to `.vitest-scratch/` paths, and `playwright.config.ts` does the equivalent for `.playwright-scratch/`. `tests/integration.test.ts` still runs a destructive `DELETE FROM items` (etc.) in `beforeEach`, but it now hits the scratch DB by default under `npm test` / `vitest run` / `npm run test:e2e`. The remaining discipline: never manually override the env var to point at `data/inventory.db`, and never invoke DB-touching code through a path that bypasses these config files. See safety fact 2 above and `resale-inventory-validation-and-qa`.

**W3 — Missing CSRF middleware.** FIXED. `middleware.ts` at repo root implements the Origin check plan.md's Security section requires, scoped to `/api/:path*`.

**W4 — No backup routine.** FIXED. `lib/backup.ts` runs a WAL-safe startup snapshot (`db.backup()`, not a bare file copy) to `data/backups/inventory-YYYYMMDD.db`, keeping the newest 7 (skipped during `next build` via `NEXT_PHASE` check). `data/backups/` on the real repo currently holds only `.gitkeep` — no real backup has been written yet, consistent with `data/inventory.db` never having been booted through a full server start. Details: `resale-inventory-run-and-operate`.

**W5 — `lib/types.ts` is a stub.** FIXED. No longer a stub — it now defines `BookDetails`, `ClothingDetails`, `Photo`, `Item` (a `category`-discriminated union), and `ItemWithRelations`, and is actively imported by `app/api/import/route.ts`. Any future shared-types refactor still lands here, but there's real content to build on now.

**W6 — Export builds the full CSV in memory.** `app/api/export/route.ts` uses `Papa.unparse` on the whole dataset (`buildCsvResponse`); plan.md says streaming. Fine at current scale — `data/inventory.db` literally has 1 row — a known scalability lie in the spec's own terms, still OPEN.

**W7 — cwd-dependent DB path.** Design decision 2's flip side: run anything that imports `lib/db.ts` from the wrong directory (with `BOOKSELLER_DB_PATH` unset) and you silently get a fresh empty DB there. Environment discipline: `resale-inventory-build-and-env` and `resale-inventory-run-and-operate`.

**W8 — Constants duplicated.** MOSTLY FIXED. Condition vocabulary (both book AND clothing, since the multi-category migration) and date regex are now single-sourced in `lib/constants.ts` (condition was previously 9 homes, date regex 3 — both now effectively 1 code home plus the SQL CHECK, which is intentionally still separate since changing it needs the table-rebuild protocol). ISBN_PATTERN (2 homes) and the money cap (4 homes) remain unconsolidated — these are now the most significant remaining duplication. Full inventory and change procedure: `resale-inventory-config-and-constants`.

**Other recorded spec-vs-code drift** (details in `resale-inventory-failure-archaeology`): `GET /api/isbn/:isbn` returning 404 on timeout where plan says 503 is FIXED (`lookupISBN` returns a discriminated `ISBNLookupResult` and the route maps not-found → 404, provider-unavailable → 503); `dev` script lacking `-H 127.0.0.1` is FIXED (`package.json`'s `dev` script is `next dev --turbopack -H 127.0.0.1`); PATCH writing `price_history.previous_price = 0` instead of NULL when the price was previously unset is now FIXED too (`002_price_history_nullable.sql` made the columns nullable, and `applyItemFieldUpdates` in `app/api/items/[id]/route.ts` now passes the raw `oldPrice`/`newPrice`, which may be `null`, straight through instead of coalescing with `?? 0`) — this item was previously recorded OPEN and should be treated as resolved.

## When NOT to use this skill

| You actually need | Go to |
|---|---|
| To classify/approve a change, or the non-negotiable gates | `resale-inventory-change-control` |
| Symptom → cause triage for a live bug | `resale-inventory-debugging-playbook` |
| The evidence trail for a past defect or drift item | `resale-inventory-failure-archaeology` |
| ISBN math, condition grades, money/CSV theory | `bookselling-domain-reference` |
| Installing, building, environment traps | `resale-inventory-build-and-env` |
| Running the app, DB file care, backups, import/export ops | `resale-inventory-run-and-operate` |
| A specific constant's value/home/how to change it | `resale-inventory-config-and-constants` |
| Running or writing tests safely | `resale-inventory-validation-and-qa` |
| Measurement scripts and interpreting their output | `resale-inventory-diagnostics-and-tooling` |
| Spec templates, docs of record, house style | `resale-inventory-docs-and-writing` |
| Executing the fix for the 500 cluster | `resale-inventory-constraint-leak-campaign` |
| Open problems / external positioning | `resale-inventory-research-frontier` |
| Proof recipes and research discipline | `resale-inventory-analysis-and-methodology` |

## Provenance and maintenance

Originally authored 2026-07-02 from direct inspection of the repo, when this was still a single-category books-only app with zero git history. Content-audited and substantially rewritten to match the current state: multi-category (books+clothing) schema, `app/api/items/*` routes, versioned migration runner, real git history with a private GitHub remote, and several Known-weak-points items upgraded from MITIGATED/PARTIALLY FIXED to FIXED after re-reading the current code. Everything cited above was re-verified against the live repo, not carried forward from the original date.

Volatile facts and one-line re-verification:

| Fact | Re-verify with |
|---|---|
| Git history is real; private remote `preston-bernstein/resale-inventory` (note: GitHub repo and npm package name were both renamed from `book-seller`; the on-disk folder path is unchanged) | `cd /Users/prestonbernstein/dev/book-seller && git log --oneline 2>&1 \| tail -1 && git remote -v` |
| `middleware.ts` present (W3 fixed) | `cd /Users/prestonbernstein/dev/book-seller && ls middleware.ts 2>&1` |
| `data/backups/` currently holds only `.gitkeep` (W4 code is fixed; still no real backup file — `lib/backup.ts`'s startup routine deliberately no-ops during `next build`/`NEXT_PHASE`, which is the only way the real DB has been booted so far; a real `next dev`/`next start` boot would produce one) | `ls /Users/prestonbernstein/dev/book-seller/data/backups` |
| `lib/types.ts` no longer a stub (W5 fixed) | `cat /Users/prestonbernstein/dev/book-seller/lib/types.ts` |
| Transition table unchanged since the original build | `cat /Users/prestonbernstein/dev/book-seller/lib/transitions.ts` |
| Real `data/inventory.db` is MIGRATED (`user_version = 3`, current `items`/`book_details`/etc. schema, 1 row) | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "PRAGMA user_version;" && sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT COUNT(*) FROM items;"` |
| Import route now normalizes AND per-row-dedupes ISBN (original Defect 2 fixed) | `cd /Users/prestonbernstein/dev/book-seller && grep -n "normalizeISBN\|seenIsbns\|isbnExists" app/api/import/route.ts` |
| Versions: next 15.5.19, better-sqlite3 ^12.11.1, vitest ^4.1.9 | `cd /Users/prestonbernstein/dev/book-seller && grep -E '"(next\|better-sqlite3\|vitest)"' package.json` |
| AC3 vs FR10 contradiction still unresolved (unaffected by the multi-category migration) | `grep -n "AC3" /Users/prestonbernstein/dev/book-seller/docs/book-inventory-management/challenge-notes.md` |
| Two spec folders now exist: `docs/book-inventory-management/` (original) and `docs/multi-category-inventory/` (books+clothing migration) | `ls /Users/prestonbernstein/dev/book-seller/docs` |

If any re-verification diverges, update this file in the same change that lands the divergence — this skill is part of the contract surface, not documentation-after-the-fact.
