---
name: resale-inventory-debugging-playbook
description: Triage runbook for the resale-inventory app (formerly book-seller). Use when debugging a 500 error or {"error":"Internal server error"}, import fails or reports row errors, data missing / all inventory rows suddenly gone, tests pass but API broken, "database is locked", curl returns HTML instead of JSON, wrong port (3000 vs a fallback), zsh "no matches found" on route paths, ISBN lookup 404/503 for a known-good ISBN, or the server won't start with a better-sqlite3 native module error. Maps each symptom to one discriminating check.
---

# Resale Inventory Debugging Playbook

Symptom-first triage for `/Users/prestonbernstein/dev/book-seller` — a local-first used-goods (books + clothing) inventory app (Next.js 15.5.19 App Router + better-sqlite3, SQLite DB at `data/inventory.db`). This skill gets you from "something is wrong" to "I know which failure this is and which skill owns the fix" in one or two commands. It does **not** contain fixes — it routes to sibling skills that do.

**Terms used once, defined here:**
- **Discriminating check** — a single command whose output splits the hypothesis space (tells you which failure you have, not just that one exists).
- **DB CHECK constraint** — a rule enforced inside SQLite itself (see `data/migrations/003_multi_category.sql`, the currently-live schema definition — `001_init.sql`/`002_price_history_nullable.sql` are earlier steps in the same versioned chain, still applied first on a fresh DB but superseded by 003 for the base tables). When application code skips validation, the CHECK throws at INSERT/UPDATE time, and an unguarded catch-all can turn that into an opaque HTTP 500. This "constraint leak" was the app's signature failure mode historically — see Trap 1/2 below for its current (fixed) status.
- **WAL** — SQLite write-ahead-log mode (enabled in `lib/db.ts`). Means the live DB is three files: `inventory.db`, `-wal`, `-shm`. Never touch any of them by hand.

## Hard safety rules (read before running anything)

1. **Running the Vitest suite from the repo root is safe by default now — verify before trusting it.** `tests/integration.test.ts`'s `beforeEach` still truncates `item_photos`/`price_history`/`item_platforms`/`clothing_details`/`book_details`/`items`, but `lib/db.ts` resolves its DB path from `BOOKSELLER_DB_PATH` (fallback: the real `data/inventory.db`), and `vitest.config.ts` sets that env var to a scratch file for every run. This was Defect T1 (see `resale-inventory-failure-archaeology`) and it's fixed. Confirm the wiring is still intact before assuming this: `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts lib/db.ts`. If either grep comes up empty, treat the DB as unprotected and use the safe procedure in **resale-inventory-validation-and-qa** instead of running tests directly.
2. **Never modify/delete/recreate `data/inventory.db`, `-wal`, or `-shm`.** Inspect read-only only, via the URI pattern in the toolkit section below.
3. **No mutating HTTP requests (POST/PATCH/DELETE) during triage.** GET-only probes. If you're trying to reproduce a defect that requires mutation, that belongs in **resale-inventory-constraint-leak-campaign**'s gated protocol, not ad hoc here.
4. If you start `npm run dev`, kill it when done, and read its stdout for the real port (see port trap below). Note: `npm run dev` now binds to `127.0.0.1` by default (`next dev --turbopack -H 127.0.0.1` — DR-4 fixed), so it is not reachable from other machines on the LAN.

## When NOT to use this skill

- **You already know the failure and want to check whether it's already fixed** (status-transition 500, import 500) → go straight to **resale-inventory-constraint-leak-campaign** — read its current status before assuming there's open work; the two defects it was created for (D1, D2) are already fixed as of this writing (see Trap 1/2 below).
- **You're changing behavior** (route code, validation, schema) → **resale-inventory-change-control** first; `docs/book-inventory-management/` and `docs/multi-category-inventory/` are the change-control authorities (the former for the original books-only spec, the latter for the clothing-category addition and its own requirements/plan/steps/TASKS).
- **Build/install/environment setup problems** (fresh clone, node version, npm install) → **resale-inventory-build-and-env**.
- **Routine operations** — starting/stopping the app, DB care, backups, port management → **resale-inventory-run-and-operate**.
- **Writing or running tests safely** → **resale-inventory-validation-and-qa**.
- **You want the full defect history with evidence transcripts** → **resale-inventory-failure-archaeology**.
- **Understanding the architecture or domain**, not a live failure → **resale-inventory-architecture-contract** / **bookselling-domain-reference**.

## Symptom → Triage table

| Symptom | First discriminating check (one command) | Likely cause | Go to |
|---|---|---|---|
| Opaque 500 on status change: `{"error":"Internal server error."}` from `POST /api/items/<id>/status` | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT status, listing_price FROM items WHERE id='<id>';"` | Historically: transition to `Listed`/`Sale Pending` with `listing_price` NULL hit a DB CHECK and leaked a 500 (Defect D1). **This is fixed** — `app/api/items/[id]/status/route.ts` now checks `listing_price` before attempting the UPDATE and returns a 422 with a clear message. If you're still seeing a 500 here, it's a NEW regression, not D1 — treat as a fresh finding | If message is the clear 422 (`Cannot list an item without a listing_price...`): working as intended, not a bug. If a raw 500: fresh finding — record in `resale-inventory-failure-archaeology` |
| Import returns per-row errors in `errors[]` and `imported` less than the row count | `sqlite3 "file:...inventory.db?mode=ro" "SELECT isbn FROM book_details WHERE isbn IS NOT NULL;"` then check the CSV for duplicate/pre-existing ISBNs | Expected behavior, not a bug: `app/api/import/route.ts` validates each row independently and reports per-row duplicate-ISBN errors without discarding other valid rows in the same batch (Defect D2, fixed) | Not a defect — see "Trap 2" below for the historical context |
| curl gets HTML instead of JSON | `curl -s http://localhost:3000/api/dashboard \| head -c 100` — starts `<!DOCTYPE html>` → wrong app | An unrelated app is squatting on port 3000; Next fell back to another port | this skill (port trap story below), ops detail in `resale-inventory-run-and-operate` |
| ALL inventory rows suddenly gone | `sqlite3 "file:...inventory.db?mode=ro" "SELECT title, created_at FROM items;"` — residue row titled `Test Book` = someone ran vitest against the real DB (config bypassed) | `npx vitest run` wiped the live DB — should be prevented by `BOOKSELLER_DB_PATH` in `vitest.config.ts` (see safety rule 1); if it happened anyway, that redirection is broken and needs its own investigation | `resale-inventory-run-and-operate` (recovery from `data/backups/`, if a startup backup had already run — check `ls data/backups/`); then investigate why the T1 fix didn't hold |
| `database is locked` / `SQLITE_BUSY` | `lsof /Users/prestonbernstein/dev/book-seller/data/inventory.db` — see who holds it | An RW `sqlite3` shell (or second process) open while the dev server runs | Close the RW shell; always inspect with `?mode=ro` URI (toolkit below) |
| zsh: `no matches found: app/api/items/[id]/route.ts` | Re-run with the path quoted: `cat "app/api/items/[id]/route.ts"` | zsh globs `[...]` — bracketed Next.js route paths must be quoted | this skill (no escalation needed) |
| ISBN lookup 404 for a known-good ISBN, or 503 | `curl -s -m 5 -o /dev/null -w "%{http_code}\n" "https://openlibrary.org/api/books?bibkeys=ISBN:9780306406157&format=json&jscmd=data"` | `lib/isbn.ts`'s `lookupISBN` now distinguishes `not-found` (→ 404) from `unavailable` (timeout/network/oversize/bad-response → 503 with `"Lookup unavailable. Enter details manually."`) — DR-3, fixed. If you're seeing 404 for a provider outage instead of 503, that's a regression | `bookselling-domain-reference` for the FR3/AC11 degraded-entry design; a 404-for-outage sighting is a regression → `resale-inventory-change-control` |
| Tests green but API misbehaves | `grep -Ln "describe.skip" tests/api/*.ts` | Should list all 8 files in `tests/api/` — that directory is the real, unskipped HTTP-layer suite now (invokes route handlers directly). If it DOESN'T cover the behavior you're chasing, the gap is real; check whether `tests/integration.test.ts`'s vestigial `describe.skip('API integration...')` block was the only place it was ever covered | `resale-inventory-validation-and-qa` |
| Server won't start: `ERR_DLOPEN` / ABI / NODE_MODULE_VERSION error mentioning better_sqlite3.node | `ls /Users/prestonbernstein/dev/book-seller/node_modules/better-sqlite3/build/Release/` — native binary present? | better-sqlite3 is a native module; a Node major upgrade breaks the ABI. Standard remedy: `npm rebuild better-sqlite3` (general knowledge, not repo-verified) | `resale-inventory-build-and-env` |
| Stray empty `data/` dir appears somewhere unexpected | `grep -n "process.cwd" /Users/prestonbernstein/dev/book-seller/lib/db.ts` | `lib/db.ts` builds the DB path from `process.cwd()` (when `BOOKSELLER_DB_PATH` is unset) and `mkdirSync`s it — running any code that imports it from another cwd creates (or worse, uses) a fresh empty DB there | `resale-inventory-architecture-contract` |
| Mutating request rejected with `{"error":"Origin not allowed."}` (403) | `curl -s -X POST -H "Origin: http://evil.example" http://127.0.0.1:<port>/api/items -d '{}'` → expect 403 | Working as intended — `middleware.ts` implements CSRF protection by rejecting mutating `/api/*` requests whose `Origin` doesn't match `Host` (DR-1, fixed). A legitimate same-origin browser request or a plain `curl` with no `Origin` header passes through | Not a bug. If a legitimate same-origin request is being rejected, that IS a bug → `resale-inventory-change-control` |

## Top traps — what actually happened, and their current (fixed) status

### Trap 1: The opaque status-transition 500 — Defect D1, FIXED

**Original story (historical record — do not re-litigate as a live bug).** A book was created via `POST /api/items` (valid body → 201 with an id). Then `POST /api/items/<id>/status` with body `{"status":"Listed"}` — a legal transition per `lib/transitions.ts` — returned **HTTP 500** because the route validated the transition graph but never checked the `listing_price` precondition before the UPDATE; the DB's `CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL)` threw, and the catch-all turned it into an opaque 500.

**Current status: FIXED.** `app/api/items/[id]/status/route.ts` now explicitly checks `item.listing_price === null` for a transition into `Listed`/`Sale Pending` *before* running the UPDATE, and returns:

```json
{"error":"Cannot list an item without a listing_price. Set a price first via PATCH."}
```

with HTTP 422 — not a 500. Fixed alongside D2/D3 in `docs/book-inventory-management/TASKS.md` Task 18 (commits `94224e2`, merged in `048f781`); regression-locked by `tests/api/items-status.test.ts`. The related SUSPECTED variant (`PATCH /api/items/<id>` clearing `listing_price` to null on a `Listed` item) was fixed at the same time — the route now rejects that with a 422 rather than letting it hit the CHECK.

**Discriminating check (read-only, safe) if you suspect a NEW regression of this shape:**

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT id, status, listing_price FROM items WHERE id='<the-id>';"
```

If the route still returns a raw 500 for this shape today, that's a fresh regression, not the original D1 — record it fresh in `resale-inventory-failure-archaeology`.

### Trap 2: Import loses valid rows over one duplicate ISBN — Defect D2, FIXED

**Original story (historical record).** A 3-row CSV was POSTed to `/api/import`: rows 1 and 2 shared an ISBN, row 3 was valid with no ISBN. The whole batch — including the innocent row 3 — was inserted inside one `db.transaction`, so the unique index on ISBN threw mid-transaction, aborting everything, and the route returned a bare 500 with 0 rows imported.

**Current status: FIXED.** `app/api/import/route.ts` now validates every row independently in `processImportRow` before any insert happens: `buildBookRow` tracks `seenIsbns` (within-file duplicates) and queries `book_details` for existing ISBNs (cross-file duplicates), producing a per-row `ImportError` for each conflict. Only rows that pass validation reach `insertValidRows`, so one bad row no longer takes down the batch. Fixed alongside D1/D3 in the same Task 18 work; regression-locked by `tests/api/import.test.ts` ("rejects duplicate ISBNs within the same file", "rejects an ISBN that already exists in inventory", plus a dozen other per-row validation cases).

**Discriminating check** if you want to confirm the current (fixed) per-row behavior rather than assume it:

```bash
# ISBNs already in the DB (book_details, not the old books table):
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT isbn FROM book_details WHERE isbn IS NOT NULL;"
# Duplicate ISBNs inside your CSV:
awk -F',' 'NR>1 {print $NF}' your-import.csv | sort | uniq -d
```

Expect the response body's `errors[]` to name the specific duplicate rows, and `imported` to equal the count of genuinely valid rows — not zero.

### Trap 3: An unrelated app squats on port 3000

**Story.** If another local app is bound to port 3000 when you run `npm run dev`, Next.js does not fail — it logs a fallback message and serves on the next free port:

```
 ⚠ Port 3000 is in use by process <pid>, using available port 3001 instead.
   - Local:        http://localhost:3001
```

Meanwhile `curl http://localhost:3000/api/dashboard` can return **HTTP 200** with an entirely different app's HTML — a silent wrong-target trap: the status code looks healthy, the body is not this app.

**Discriminating check:**

```bash
curl -s http://localhost:3000/api/dashboard | head -c 30
```

Expected if trapped: HTML (`<!DOCTYPE html>` or similar), not JSON. Expected if this app actually got :3000: JSON starting `{"held_count":`. Always read the dev-server stdout for the real port; never assume 3000. Note `npm run dev` now binds `-H 127.0.0.1` by default, which changes *reachability* (localhost only) but not this fallback-port behavior.

### Trap 4: The vitest wipe — now prevented by config, verify the prevention

**Story (historical, T1).** `npx vitest run` used to report a reassuring "N passed" and silently delete every row from the live tables in the real `data/inventory.db`, because the DB path had no override. This is what the residual `Test Book` row in the real DB is evidence of (a past wipe, from before the fix — or it's the deliberately-seeded row the app currently ships with; either is consistent with the current DB contents).

**Current status: mitigated by config, not by discipline.** `vitest.config.ts` sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` to `.vitest-scratch/` paths in its `test.env` block, and `lib/db.ts`/`lib/photos.ts` both honor those env vars. A plain `npx vitest run` from the repo root should now be safe. It is still worth checking the real DB's state before and after any test-adjacent activity, because config drift is exactly the kind of thing that silently breaks:

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT title, category, created_at FROM items ORDER BY created_at DESC LIMIT 5;"
```

If row count or contents changed unexpectedly after running any test command, the redirection broke — treat as a fresh, serious finding (not a re-confirmation of the old T1) and check `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts` immediately. Recovery and backup routine: `resale-inventory-run-and-operate`. Safe testing procedure: `resale-inventory-validation-and-qa`.

### Trap 5: Green tests, broken API — historical shape, now closed

**Story.** D1 and D2 both existed while a large fraction of the suite passed, because the entire HTTP-request layer was a `describe.skip` block. Passing unit tests for `lib/transitions.ts` proved the transition *graph*, not the *route's* handling of DB constraint violations.

**Current status:** `tests/api/*.ts` (8 files) now exercises real route handlers directly (no server, no skip) and specifically regression-locks D1/D2/D3. The old skipped block still exists in `tests/integration.test.ts` §5 but is vestigial, not the only coverage of this layer anymore.

**Discriminating check** if you're worried a NEW route change shipped without HTTP-layer coverage:

```bash
grep -Ln "describe.skip" tests/api/*.ts | wc -l   # expect 8 (none skipped)
grep -n "describe.skip" tests/integration.test.ts  # expect exactly the vestigial §5 block
```

If your bug is in request handling, status codes, or constraint interaction and none of `tests/api/*` covers it, the gap is real for that specific route/case — not a repo-wide blind spot anymore.

## Safe evidence-gathering toolkit

All commands below are read-only / GET-only.

**Read-only SQLite (the ONLY approved way to open the DB):**

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT COUNT(*) FROM items; SELECT status, COUNT(*) FROM items GROUP BY status;"
```

The `?mode=ro` URI avoids taking a write lock, so it is safe while the dev server runs (a plain RW `sqlite3 data/inventory.db` shell is how you cause `SQLITE_BUSY` — don't). Live schema note: the base table is `items`; per-category detail lives in `book_details`/`clothing_details` (joined on `item_id`); the pre-migration `books`/`book_platforms` tables still physically exist as `books_archived`/`book_platforms_archived` (renamed, not dropped, by `data/migrations/003_multi_category.sql`) but hold no live data going forward — don't query them expecting current inventory.

**Port detection:**

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN; lsof -nP -iTCP:3001 -sTCP:LISTEN
```

Or grep the dev log: `grep -m1 "Local:" dev.log` → `- Local: http://localhost:<port>`.

**Starting/stopping a probe server (only if not already running):**

```bash
cd /Users/prestonbernstein/dev/book-seller && nohup npm run dev > /tmp/bs-dev.log 2>&1 &
sleep 4 && grep -E "Port 3000|Local:" /tmp/bs-dev.log   # read the REAL port here
# ... probes ...
kill %1    # or kill <pid>; then verify: lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Remember `npm run dev` binds `127.0.0.1` only now, so probe from the same machine.

**GET-only probes with expected shapes:**

```bash
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:<port>/api/dashboard
```

```json
{"held_count":1,"held_acquisition_cost":1000,
 "by_condition":{"Poor":0,"Acceptable":0,"Good":1,"Very Good":0,"Like New":0,"NWT":0,"NWOT":0,"EUC":0,"GUC":0,"Fair":0},
 "by_status":{"Unlisted":0,"Listed":1,"Sale Pending":0,"Sold":0,"Removed":0,"Donated":0,"Discarded":0},
 "by_category":{"book":{"count":1,"acquisition_cost":1000},"clothing":{"count":0,"acquisition_cost":0}}}
HTTP 200
```

(`by_condition` now merges both categories' vocabularies since dashboard math combined `BOOK_CONDITIONS`/`CLOTHING_CONDITIONS`; `by_category` is new — verify shape against `lib/dashboard.ts`'s `DashboardData` interface if this drifts.)

```bash
curl -s -w "\nHTTP %{http_code}\n" "http://127.0.0.1:<port>/api/items?limit=5"
# → {"items":[{ id, category, title, status, acquisition_cost, acquisition_date,
#    listing_price, sale_price, sale_date, sale_platform, created_at, updated_at,
#    platforms:[...], cover_photo_id, details:{...category-specific fields...} }],
#    "total":N, "page":0, "limit":5}  HTTP 200
curl -s -w "\nHTTP %{http_code}\n" "http://127.0.0.1:<port>/api/items?limit=999"
# → {"error":"limit must be 1–200."}  HTTP 400   (handy known-good 4xx probe)
curl -s -w "\nHTTP %{http_code}\n" "http://127.0.0.1:<port>/api/items/<id>"
# → item + relations (platforms, price_history, photos); 404 {"error":"Not found."} for unknown id
curl -s "http://127.0.0.1:<port>/api/export" | head -2
# → CSV with header id,category,title,isbn,... (GET, read-only)
```

**Quoting bracketed route paths in zsh (always):**

```bash
cat "/Users/prestonbernstein/dev/book-seller/app/api/items/[id]/status/route.ts"
```

**Known drift to keep in mind while reading evidence** (details in `resale-inventory-architecture-contract` — verify current status there too, this list moves fast): `middleware.ts` now EXISTS and implements CSRF Origin-checking on mutating `/api/*` routes (DR-1, fixed — do not assume "no CSRF protection" anymore); `lib/types.ts` is a real, populated file (`Item`, `ItemWithRelations`, `BookDetails`, `ClothingDetails`, etc.) — it is not a stub; `price_history.previous_price`/`new_price` are written as `NULL` (not coalesced to `0`) when there was no prior/new price (DR-7, fixed) — a `previous_price` of exactly `0` in evidence now genuinely means "was zero/free," not "was NULL." The automated startup backup routine also now exists (`lib/backup.ts`, DR-2 fixed) — `data/backups/` not being empty is expected on a machine that's had a real server boot, not a red flag.

## Escalation rules

1. **Triage says the fix changes behavior** (status codes, validation, schema, route logic) → stop; open **resale-inventory-change-control**. `docs/book-inventory-management/` (original books-only spec) and `docs/multi-category-inventory/` (clothing-category addition) together are the change-control authority; no behavior change without it.
2. **You've found what looks like D1 or D2 again** → first confirm it's not just a NEW bug with the same shape (both are fixed and regression-tested — see Trap 1/2 above). If reproducible, that's a fresh finding, not a live campaign — record it per `resale-inventory-failure-archaeology` format and treat `resale-inventory-constraint-leak-campaign`'s gated protocol as the template for how to reproduce and fix it safely, not as "still open work."
3. **Brand-new failure** (not in the table above) → record it in **resale-inventory-failure-archaeology** format (dated symptom, exact command + output transcript, root-cause hypothesis, verification status) before or alongside fixing. Then add a row to this playbook's triage table.
4. **Need scripts** (port-detect, api-smoke, db-integrity, constants-drift) → **resale-inventory-diagnostics-and-tooling**. All four scripts already target the current `/api/items` routes and `items`/`book_details`/`clothing_details` schema (verified directly, including a live read-only run of `db-integrity.sh` and `constants-drift.sh`).

## Provenance and maintenance

Originally authored 2026-07-02 from direct source reading of a single-category (books-only) build. Refreshed after the multi-category migration, the QA-hardening pass (Vitest/Playwright/Stryker/fallow), and the dark-mode/UX pass: re-verified by reading `lib/db.ts`, `lib/transitions.ts`, `lib/isbn.ts`, `lib/dashboard.ts`, `middleware.ts`, `lib/types.ts`, all current `app/api/**/route.ts` files, `tests/integration.test.ts`, `tests/api/*.ts`, and `data/migrations/00{1,2,3}_*.sql`; cross-checked against `git log` for the T1/D1/D2/D3/DR-1/DR-2/DR-3/DR-4/DR-7 fix commits and `docs/book-inventory-management/TASKS.md`. Items marked ASSUMPTION/OPEN/SUSPECTED elsewhere in the skill library are unverified by this pass unless explicitly called out above as re-checked.

One-line re-verification commands:

- CHECK constraint still present: `grep -n "listing_price IS NOT NULL" data/migrations/003_multi_category.sql`
- Status route pre-checks listing_price (D1 still fixed): `grep -n "missingListingPrice" "app/api/items/[id]/status/route.ts"`
- Import still validates per-row, not single-transaction-abort (D2 still fixed): `grep -n "seenIsbns\|isbnExists" app/api/import/route.ts`
- vitest DB-path redirection still wired (T1 still fixed): `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts lib/db.ts`
- CSRF middleware still present (DR-1 still fixed): `grep -n "MUTATING_METHODS" middleware.ts`
- price_history NULL-not-zero still correct (DR-7 still fixed): `grep -n "oldPrice, newPrice" "app/api/items/[id]/route.ts"`
- Port fallback story still applies: start `npm run dev` and read the first log lines for the actual bound port.
- `tests/api/*` still unskipped: `grep -Ln "describe.skip" tests/api/*.ts | wc -l` (expect the full file count, currently 8)
- Native binary present: `ls /Users/prestonbernstein/dev/book-seller/node_modules/better-sqlite3/build/Release/`
- DB reachable read-only: `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT COUNT(*) FROM items;"`
