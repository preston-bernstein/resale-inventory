---
name: book-seller-run-and-operate
description: Operating runbook for the book-seller app - starting/stopping the server, finding the real port, database file care (WAL files, backups, restore), CSV export/import operations, and deployment cautions. Use when asked to "start the app", "run dev", "which port", "backup the database", "restore", "export CSV", "import CSV", "deploy", or when touching anything under data/. Not for initial setup (build-and-env) or debugging (debugging-playbook).
---

# Book-Seller — Run and Operate

Operating manual for the running app and its data. The core mental model: **`data/inventory.db` is the business's only copy of its inventory.** Every rule in this file exists to keep that file alive and correct.

## The sacred-DB rules (project law)

> ASSUMPTION (coordinator-approved, 2026-07-02): these rules are project law even though no repo doc states them yet.

1. **Never delete or recreate `data/inventory.db`.** A startup backup routine exists (DR-2 fixed, Task 24 — daily snapshot to `data/backups/`, keeps 7), but it is a safety net, not a substitute for care: Git cannot restore the live DB — everything under `data/` except migrations is gitignored.
2. **Never run `npx vitest run` from the repo root.** The test suite deletes every row in `books`, `book_platforms`, and `price_history` in the real DB (`tests/integration.test.ts`, `beforeEach` at ~line 138). Safe procedure: see `book-seller-validation-and-qa`.
3. **Never open a read-write `sqlite3` shell on the DB while the server runs.** Use the read-only URI (below) for inspection.
4. **Never deploy to an ephemeral filesystem** (Vercel, most container platforms without volumes). Each deploy silently wipes the DB (`docs/book-inventory-management/plan.md`, Risk 4). This app is designed to run on a machine you control, from the repo directory.
5. **Restore from backup is an OWNER-ONLY action.** Agents document it; humans execute it. See "Restore" below.

## Starting the app

| Command | What it does | Notes |
|---|---|---|
| `npm run dev` | Dev server, Turbopack, hot reload | Binds all interfaces; port 3000 *or fallback* (see port trap) |
| `npm run build` then `npm run start` | Production-mode local serving | Build first or `start` fails |
| `npx next dev --turbopack -H 127.0.0.1 -p 3005` | Hardened dev: localhost-only, explicit port | Verified working 2026-07-02 |
| `npx next start -H 127.0.0.1` | Hardened prod-mode | `-H` accepted by both dev and start |

Run all commands from `/Users/prestonbernstein/dev/book-seller`. `lib/db.ts` resolves the DB from `process.cwd()` — starting the server from any other directory creates a fresh empty DB there and the app will show zero inventory (see `book-seller-build-and-env`, first-run behavior).

**Known gap (OPEN, drift item DR-4 in `book-seller-failure-archaeology`):** the stock `npm run dev` script does NOT bind localhost-only, though `plan.md` Security requires `-H 127.0.0.1`. Anyone on the LAN can reach the app (and its mutating routes — there is no auth and no CSRF middleware). Prefer the hardened variants above.

### The port trap (verified live 2026-07-02)

Port 3000 on this machine is frequently occupied by an unrelated Flutter web app. Next.js then logs:

```
⚠ Port 3000 is in use by process 27675, using available port 3001 instead.
```

and serves on **3001**. `curl http://localhost:3000/...` still returns **HTTP 200** — with Flutter HTML, not this app. Never trust a 200; verify you are talking to book-seller:

```bash
# A real book-seller response contains "held_count":
curl -s http://localhost:3001/api/dashboard | head -c 80
# → {"held_count":...
```

Or pin the port yourself with `-p 3005` as above. `book-seller-diagnostics-and-tooling` ships `scripts/find-port.sh` which automates this discrimination.

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
| `data/migrations/001_init.sql` | Schema, applied idempotently at every server start by `lib/db.ts` | Version-controlled; changes gated by `book-seller-change-control` |
| `data/backups/` | Backup target: daily startup snapshots `inventory-YYYYMMDD.db` (newest 7 kept) plus `.gitkeep` | **Automated startup backup now runs** (DR-2 fixed, Task 24) — `lib/backup.ts` snapshots the DB via WAL-safe `db.backup()` on every server start (plan.md Risk 6). The manual operator procedure below is still valid for on-demand snapshots before risky ops. |

Everything under `data/` except `migrations/` and `.gitkeep` files is gitignored (`.gitignore`: `data/inventory.db`, `data/backups/`, `*.db`, `*.db-shm`, `*.db-wal`).

## Backup (operator procedure — documented, not executed during authoring)

Safe **while the app is running** (SQLite's `.backup` is WAL-aware and takes a consistent snapshot):

```bash
cd /Users/prestonbernstein/dev/book-seller
sqlite3 data/inventory.db ".backup 'data/backups/inventory-$(date +%Y%m%d).db'"
```

Then verify the backup:

```bash
sqlite3 "data/backups/inventory-$(date +%Y%m%d).db" "PRAGMA integrity_check; SELECT COUNT(*) FROM books;"
# → ok
# → <row count matching your expectation>
```

Retention: keep at least the last 7 (plan.md Risk 6's spec). Automated startup backups now cover the daily case (DR-2, Task 24 — `lib/backup.ts` writes `inventory-YYYYMMDD.db` at every server start, keeping 7). Still run this manual snapshot before ANY risky operation (imports, schema work, running tests, campaign probes): the automated one is daily-granular and first-of-the-day-wins, so it won't capture state created since this morning's boot.

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
sqlite3 "file:data/inventory.db?mode=ro" "SELECT status, COUNT(*) FROM books GROUP BY status;"

# Schema dump
sqlite3 "file:data/inventory.db?mode=ro" ".schema books"

# Recent price changes
sqlite3 "file:data/inventory.db?mode=ro" "SELECT book_id, previous_price, new_price, changed_at FROM price_history ORDER BY changed_at DESC LIMIT 10;"

# Held capital (should match /api/dashboard held_acquisition_cost, in cents)
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COALESCE(SUM(acquisition_cost),0) FROM books WHERE status IN ('Unlisted','Listed','Sale Pending');"
```

`book-seller-diagnostics-and-tooling` ships `scripts/db-integrity.sh` for the full invariant sweep.

## CSV data flows

### Export (safe — GET, read-only)

```bash
curl -s "http://127.0.0.1:<port>/api/export" -o inventory-export.csv
```

- Response: `Content-Type: text/csv`, `Content-Disposition: attachment; filename="inventory-<YYYY-MM-DD>.csv"`.
- Column order is fixed by the `HEADERS` array in `app/api/export/route.ts`; `_usd` columns are decimal strings ("0.00"), everything else raw.
- Cells starting with `=`, `+`, `-`, `@` arrive tab-prefixed (formula-injection defense — see `bookselling-domain-reference`).

### Import (MUTATING — operator-run only)

```bash
curl -s -X POST "http://127.0.0.1:<port>/api/import" -F "file=@your-file.csv"
# Success shape: {"imported": N, "errors": [{"row": R, "fields": [...], "message": "..."}]}
```

Required columns: `title, author, condition, acquisition_cost_usd, acquisition_date`. All imported rows are created as `Unlisted`; sale-related columns are ignored. 10 MB hard limit (413 beyond).

> **WARNING — live Defect D2 (verified 2026-07-02):** if the CSV contains a duplicate ISBN — duplicated *within the file* or *already present in the DB* — the route returns HTTP 500 and imports **zero rows**, including all valid ones. Until fixed, de-duplicate ISBNs against the DB before importing (query above) or strip the `isbn` column. Fix work is gated: `book-seller-constraint-leak-campaign`.

**Back up before any import** (dedup mistakes are otherwise permanent — there is no undo and no DELETE API route).

## What lands where

- `.next/` — build output (regenerable, gitignored).
- Logs: console/stdout only. No log files, no PID files. If you background the server, redirect output yourself and keep the log — it is the only place the real port is printed.
- CSV exports land wherever you point `curl -o`.

## When NOT to use this skill

- Setting the project up from scratch, `npm ci`, native-module build issues → `book-seller-build-and-env`.
- A 500, missing data, or wrong-looking behavior → `book-seller-debugging-playbook`.
- Running or writing tests safely → `book-seller-validation-and-qa`.
- Fixing the import/transition 500 defects → `book-seller-constraint-leak-campaign`.
- Meaning of statuses, held inventory, money units → `bookselling-domain-reference`.
- Exact values of limits (10 MB, 200-char q, …) and where they are defined → `book-seller-config-and-constants`.

## Provenance and maintenance

Authored 2026-07-02 against Next.js 15.5.19, better-sqlite3 ^12.11.1, sqlite3 CLI 3.51.0, macOS. Verified live that day: port-3000 fallback message text; `-H 127.0.0.1 -p 3005` accepted by `next dev`; `/api/dashboard` JSON shape; D2 import failure. Not executed during authoring (operator procedures): `.backup`, restore, import.

Re-verify when in doubt:
- Port fallback + real port: `npm run dev` and read the first 5 log lines.
- `-H` still accepted: `npx next dev --turbopack -H 127.0.0.1 -p 3005` (then kill).
- Backup routine present (DR-2 fixed, Task 24): `grep -rn "runStartupBackup" lib/ --include="*.ts"` (expect hits in `lib/backup.ts` and `lib/db.ts`); after a server start, `ls data/backups/` shows `inventory-YYYYMMDD.db`.
- D2 still live: see the gated reproduction in `book-seller-constraint-leak-campaign` (do not casually re-run).
- Export headers: `grep -n "const HEADERS" app/api/export/route.ts`.
