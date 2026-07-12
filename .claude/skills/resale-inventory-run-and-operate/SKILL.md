---
name: resale-inventory-run-and-operate
description: Operating runbook for the resale-inventory app (formerly book-seller) - starting/stopping the server, finding the real port, database file care (WAL files, backups, restore), CSV export/import operations, and deployment cautions. Use when asked to "start the app", "run dev", "which port", "backup the database", "restore", "export CSV", "import CSV", "deploy", or when touching anything under data/. Not for initial setup (build-and-env) or debugging (debugging-playbook).
---

# Resale Inventory — Run and Operate

Operating manual for the running app and its data. The core mental model: **`data/inventory.db` is the business's only copy of its inventory.** Every rule in this file exists to keep that file alive and correct.

The app now tracks two categories (books and clothing) on a shared `items` base table plus per-category satellite tables (`book_details`, `clothing_details`) — see the schema note under "Data topology" below. Everything else about operating the app (starting it, backing it up, CSV flows) still works the same way it did as a books-only app.

## The sacred-DB rules (project law)

> ASSUMPTION (coordinator-approved, originally 2026-07-02): these rules are project law even though no repo doc states them as a single checklist.

1. **Never delete or recreate `data/inventory.db`.** A startup backup routine exists (DR-2, fixed — `lib/backup.ts`, wired into `lib/db.ts`; daily snapshot to `data/backups/`, keeps newest 7), but it is a safety net, not a substitute for care: Git cannot restore the live DB — everything under `data/` except `migrations/` is gitignored.
2. **Running the test suite from the repo root is now safe by default — but verify this before trusting it.** `tests/integration.test.ts`'s `beforeEach` still truncates tables (`DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;` — around line 138-140), but `lib/db.ts` now resolves its DB path from `process.env.BOOKSELLER_DB_PATH` (falling back to the real `data/inventory.db` only when unset), and `vitest.config.ts` sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` to scratch files under `.vitest-scratch/` for every test run via its `test.env` block. `playwright.config.ts` does the same under `.playwright-scratch/` for E2E. This was the T1 defect (see `resale-inventory-failure-archaeology`) and it is fixed. Re-verify the safety net is still wired before relying on it: `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts playwright.config.ts` (expect a hit in each `env`/`test.env` block) — full procedure in `resale-inventory-validation-and-qa`.
3. **Never open a read-write `sqlite3` shell on the DB while the server runs.** Use the read-only URI (below) for inspection.
4. **Never deploy to an ephemeral filesystem** (Vercel, most container platforms without volumes). Each deploy silently wipes the DB (`docs/book-inventory-management/plan.md`, Risk 4). This app is designed to run on a machine you control, from the repo directory.
5. **Restore from backup is an OWNER-ONLY action.** Agents document it; humans execute it. See "Restore" below.

## Starting the app

| Command | What it does | Notes |
|---|---|---|
| `npm run dev` | Dev server, Turbopack, hot reload | **Already binds to `127.0.0.1` only** — the script is `next dev --turbopack -H 127.0.0.1` (DR-4 fixed, `docs/book-inventory-management/TASKS.md` Task 21). Port 3000 *or fallback* (see port trap) |
| `npm run build` then `npm run start` | Production-mode local serving | `build` runs `next build --turbopack`; `start` runs plain `next start` (no `-H` flag — binds all interfaces). Build first or `start` fails. If you need localhost-only prod serving, run `npx next start -H 127.0.0.1` directly |
| `npx next dev --turbopack -H 127.0.0.1 -p 3005` | Dev with an explicit pinned port | Useful when you want a stable port instead of the 3000+fallback dance; redundant with plain `npm run dev` for the localhost-binding part, which is now the default |
| `npx next start -H 127.0.0.1` | Hardened prod-mode, localhost-only | `-H` accepted by both `next dev` and `next start` |

Run all commands from `/Users/prestonbernstein/dev/book-seller`. `lib/db.ts` resolves the DB from `process.cwd()` (when `BOOKSELLER_DB_PATH` is unset) — starting the server from any other directory creates a fresh empty DB there and the app will show zero inventory (see `resale-inventory-build-and-env`, first-run behavior).

Mutating API routes now also have CSRF protection: `middleware.ts` rejects any `POST`/`PUT`/`PATCH`/`DELETE` under `/api/*` whose `Origin` header doesn't match the request's `Host` (DR-1, fixed). There is still no authentication — anyone who can reach the bound interface can use the app; binding to `127.0.0.1` by default is what actually keeps LAN neighbors out now.

### The port trap

Port 3000 on this machine has historically been occupied by an unrelated Flutter web app. When that happens, Next.js logs something like:

```
⚠ Port 3000 is in use by process <pid>, using available port 3001 instead.
```

and serves on the next free port. `curl http://localhost:3000/...` can still return **HTTP 200** — with a different app's HTML, not this one. Never trust a 200; verify you are talking to this app:

```bash
# A real resale-inventory response contains "held_count":
curl -s http://localhost:3001/api/dashboard | head -c 80
# → {"held_count":...
```

Or pin the port yourself with `-p 3005` as above. `resale-inventory-diagnostics-and-tooling` ships `scripts/find-port.sh` which automates this discrimination (it only trusts the `held_count` JSON signature, never the status code).

### Stopping

```bash
pkill -f "next dev --turbopack"    # dev server
pkill -f "next start"              # prod-mode server
```

Verify it is gone: `curl -s -o /dev/null --max-time 2 http://localhost:<port>/api/dashboard || echo stopped`.

## Data topology

| Path | What it is | Care |
|---|---|---|
| `data/inventory.db` | The only copy of all inventory data (SQLite) | Sacred. Never delete/recreate |
| `data/inventory.db-wal` | Write-Ahead Log — recent committed writes live HERE until checkpoint | Copying the `.db` alone can lose recent data; use `.backup` (below), never bare `cp` |
| `data/inventory.db-shm` | Shared-memory index for WAL | Managed by SQLite; ignore |
| `data/migrations/*.sql` | Three versioned migration files (`001_init.sql`, `002_price_history_nullable.sql`, `003_multi_category.sql`), applied in order by `lib/db.ts` | `lib/db.ts` loops a `VERSIONED_MIGRATIONS` array and gates each file on `PRAGMA user_version` — an already-migrated DB re-runs nothing. Version-controlled; changes gated by `resale-inventory-change-control` |
| `data/backups/` | Backup target: daily startup snapshots `inventory-YYYYMMDD.db` (newest 7 kept) plus `.gitkeep` | **Automated startup backup runs on every real server boot** (DR-2, fixed) — `lib/backup.ts` snapshots the DB via WAL-safe `db.backup()`, skips during `next build`, and swallows its own errors so a backup failure never blocks boot. The manual operator procedure below is still valid for on-demand snapshots before risky ops. |

Everything under `data/` except `migrations/` and `.gitkeep` files is gitignored (see `.gitignore`: `data/inventory.db`, `/data/backups/*` with `!/data/backups/.gitkeep`, `/data/photos/*` with `!/data/photos/.gitkeep`, `*.db`, `*.db-shm`, `*.db-wal`).

**Schema note:** the live tables are `items` (shared base: id, category, title, status, money fields, dates) plus `book_details` and `clothing_details` (per-category satellites keyed on `item_id`), `item_platforms`, `item_photos`, and `price_history` (keyed on `item_id`). The migration that introduced this (`data/migrations/003_multi_category.sql`) renamed the old single-category tables to `books_archived` and `book_platforms_archived` rather than dropping them — they still physically exist in the schema as a rollback snapshot but hold no live data going forward. Every query below targets the live tables, not the archived ones.

## Backup (operator procedure — documented, not executed during authoring)

Safe **while the app is running** (SQLite's `.backup` is WAL-aware and takes a consistent snapshot):

```bash
cd /Users/prestonbernstein/dev/book-seller
sqlite3 data/inventory.db ".backup 'data/backups/inventory-$(date +%Y%m%d).db'"
```

Then verify the backup:

```bash
sqlite3 "data/backups/inventory-$(date +%Y%m%d).db" "PRAGMA integrity_check; SELECT COUNT(*) FROM items;"
# → ok
# → <row count matching your expectation>
```

Retention: keep at least the last 7 (`plan.md` Risk 6's spec). Automated startup backups now cover the daily case (DR-2, fixed — `lib/backup.ts` writes `inventory-YYYYMMDD.db` on every real server boot, keeping 7; first-snapshot-of-the-day wins so it won't overwrite a good backup with a bad restart). Still run this manual snapshot before ANY risky operation (imports, schema work, running tests against the real DB on purpose, campaign probes): the automated one is daily-granular and first-of-the-day-wins, so it won't capture state created since this morning's boot.

## Restore (OWNER-ONLY)

1. **Stop the server** (a live server holds the WAL; restoring under it corrupts state).
2. Owner copies the chosen backup over `data/inventory.db` and deletes stale `-wal`/`-shm` files.
3. Restart, then verify: `curl -s http://127.0.0.1:<port>/api/dashboard` and spot-check counts.

Agents must never perform steps 2–3 unprompted: overwriting the live DB is exactly the class of action the sacred-DB rules exist to prevent. Present the commands; let the human run them.

## Read-only inspection cookbook

Always use the read-only URI so you cannot write and cannot block the server:

```bash
cd /Users/prestonbernstein/dev/book-seller

# Row counts per status
sqlite3 "file:data/inventory.db?mode=ro" "SELECT status, COUNT(*) FROM items GROUP BY status;"

# Schema dump
sqlite3 "file:data/inventory.db?mode=ro" ".schema items"

# Recent price changes (price_history is keyed on item_id, not book_id)
sqlite3 "file:data/inventory.db?mode=ro" "SELECT item_id, previous_price, new_price, changed_at FROM price_history ORDER BY changed_at DESC LIMIT 10;"

# Held capital (should match /api/dashboard held_acquisition_cost, in cents)
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COALESCE(SUM(acquisition_cost),0) FROM items WHERE status IN ('Unlisted','Listed','Sale Pending');"

# Per-category condition, joined against the right satellite table
sqlite3 "file:data/inventory.db?mode=ro" "SELECT bd.condition, COUNT(*) FROM items i JOIN book_details bd ON bd.item_id = i.id GROUP BY bd.condition;"
sqlite3 "file:data/inventory.db?mode=ro" "SELECT cd.condition, COUNT(*) FROM items i JOIN clothing_details cd ON cd.item_id = i.id GROUP BY cd.condition;"
```

`resale-inventory-diagnostics-and-tooling` ships `scripts/db-integrity.sh` for the full invariant sweep — it already targets the current `items`/`book_details`/`clothing_details` schema (verified by reading and running it read-only).

## CSV data flows

### Export (safe — GET, read-only)

```bash
curl -s "http://127.0.0.1:<port>/api/export" -o inventory-export.csv
```

- Response: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="inventory-<YYYY-MM-DD>.csv"`.
- Column order is fixed by the `HEADERS` array in `app/api/export/route.ts`: `id, category, title, isbn, author, publisher, brand, size_label, color, material, gender_department, weight_oz, pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in, condition, acquisition_cost_usd, acquisition_date, status, listing_price_usd, platforms, sale_price_usd, sale_platform, sale_date, gross_profit_usd, created_at, updated_at`. `_usd` columns are decimal strings ("0.00"); book-only and clothing-only columns are blank for rows of the other category.
- Cells starting with `=`, `+`, `-`, `@` arrive tab-prefixed (formula-injection defense — see `bookselling-domain-reference`).

### Import (MUTATING — operator-run only)

```bash
curl -s -X POST "http://127.0.0.1:<port>/api/import" -F "file=@your-file.csv"
# Success shape: {"imported": N, "errors": [{"row": R, "fields": [...], "message": "..."}]}
```

Every row now needs a `category` column (`book` or `clothing`) — it determines which required-field list and condition vocabulary apply. Required columns: `category, title, condition, acquisition_cost_usd, acquisition_date`, plus `author` for `category=book` rows and `brand, size_label` for `category=clothing` rows (`app/api/import/route.ts`, `BOOK_REQUIRED_FIELDS`/`CLOTHING_REQUIRED_FIELDS`). All imported rows are created as `Unlisted`; sale-related columns are ignored. 10 MB hard limit (413 beyond).

> **Historical defect, now FIXED:** an earlier version of this route aborted the entire batch with an opaque HTTP 500 if the CSV contained a duplicate ISBN (within the file or already in the DB) — losing every valid row along with the bad ones (Defect D2, tracked in `resale-inventory-constraint-leak-campaign`, fixed in `docs/book-inventory-management/TASKS.md` Task 18 / commit `94224e2`). The current route validates each row independently (`processImportRow`) and reports per-row duplicate-ISBN errors in the `errors` array without discarding the other valid rows in the batch — `insertValidRows` only inserts rows that already passed validation, in one transaction. Verify this is still true before relying on it in a new context: `grep -n "already present earlier in this file\|already exists in inventory" app/api/import/route.ts`.

**Back up before any import** (mistakes are otherwise permanent — there is no undo and no DELETE API route for items; only individual photos can be deleted via `DELETE /api/items/:id/photos/:photoId`).

## What lands where

- `.next/` — build output (regenerable, gitignored).
- Logs: console/stdout only. No log files, no PID files. If you background the server, redirect output yourself and keep the log — it is the only place the real port is printed.
- CSV exports land wherever you point `curl -o`.

## When NOT to use this skill

- Setting the project up from scratch, `npm ci`, native-module build issues → `resale-inventory-build-and-env`.
- A 500, missing data, or wrong-looking behavior → `resale-inventory-debugging-playbook`.
- Running or writing tests safely → `resale-inventory-validation-and-qa`.
- Fixing import/transition defects → `resale-inventory-constraint-leak-campaign` (note: the two headline defects it was created for, D1/D2, are already fixed — check its current status before assuming there's live work there).
- Meaning of statuses, held inventory, money units → `bookselling-domain-reference`.
- Exact values of limits (10 MB, 200-char q, …) and where they are defined → `resale-inventory-config-and-constants`.

## Provenance and maintenance

Originally authored 2026-07-02 against a single-category (books-only) build on Next.js 15.5.19, better-sqlite3 ^12.11.1, sqlite3 CLI 3.51.0, macOS. Refreshed against the current multi-category (books + clothing) codebase after the QA-hardening and UX/dark-mode passes: verified by reading `lib/db.ts`, `lib/backup.ts`, `middleware.ts`, `package.json`, `.gitignore`, `data/migrations/00{1,2,3}_*.sql`, `app/api/export/route.ts`, `app/api/import/route.ts`, and by a read-only query against the real `data/inventory.db` (confirmed `PRAGMA user_version = 3`, live tables `items`/`book_details`/`clothing_details`/`item_platforms`/`item_photos`/`price_history`, one `Test Book` row) and against `git log` (commits fixing T1, DR-1, DR-2, DR-3, DR-4, DR-7, and the D1/D2/D3 constraint-leak cluster). Not executed during this refresh (operator procedures): `.backup`, restore, import.

Re-verify when in doubt:
- Port fallback + real port: `npm run dev` and read the first 5 log lines.
- Dev server already binds `127.0.0.1`: `grep -n '"dev"' package.json` (expect `-H 127.0.0.1` in the script).
- CSRF middleware present: `grep -n "MUTATING_METHODS\|Origin not allowed" middleware.ts`.
- Backup routine present: `grep -rn "runStartupBackup" lib/ --include="*.ts"` (expect hits in `lib/backup.ts` and `lib/db.ts`); after a real server start, `ls data/backups/` shows `inventory-YYYYMMDD.db`.
- Test-DB isolation still wired: `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts playwright.config.ts lib/db.ts lib/photos.ts`.
- Import per-row duplicate handling still present: `grep -n "seenIsbns\|isbnExists" app/api/import/route.ts`.
- Export headers: `grep -n "const HEADERS" app/api/export/route.ts`.
- Live schema version: `sqlite3 "file:data/inventory.db?mode=ro" "PRAGMA user_version;"` (read-only, safe).
