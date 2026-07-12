# Research note — Durability automation (frontier item 3 / DR-2)

**Status:** investigation only, read-only inspection. No code changed, no API called, no tests run.
**Date:** 2026-07-03
**Frontier item:** `resale-inventory-research-frontier` item 3 ("cheapest, highest value; do this first")
**Tracked as:** DR-2 in `resale-inventory-failure-archaeology` (OPEN), compounds T1 (`vitest run` wipes the real DB with no backup net behind it).

## What was verified read-only

- `grep -rn "backup" . --include="*.ts" --include="*.js" --include="*.json" --exclude-dir=node_modules --exclude-dir=.git` → zero hits. No backup code exists anywhere in the app.
- `data/backups/` exists but contains only `.gitkeep` — the directory was scaffolded (commit `2ebb1ae`) but never wired up.
- `plan.md` line 268 (Risk 6) specifies the intended routine: "a startup routine that copies `data/inventory.db` to `data/backups/inventory-YYYYMMDD.db` (keeping last 7 copies)". This was never implemented. Confirms DR-2 exactly as recorded.
- `lib/db.ts` is the only module-level side-effecting entry point today (runs `mkdirSync`, opens the DB, execs the migration SQL on import) — it is the natural hook point plan.md implies for a "startup routine," since there is no other app-lifecycle hook in this Next.js project (no custom server, no instrumentation.ts).

## A finding not previously recorded: naive file-copy would be unsafe under WAL

`lib/db.ts:14` enables `journal_mode = WAL`. Under WAL mode, committed data can live in `data/inventory.db-wal` (observed at 4.1 MB during this investigation — larger than the 64 KB main DB file) until a checkpoint occurs. Plan.md's Risk 6 wording — "copies `data/inventory.db` to `inventory-YYYYMMDD.db`" — reads as a plain file copy. A plain `fs.copyFile` of only the main `.db` file, taken while the `-wal` file holds uncheckpointed pages, would silently produce a backup **missing recent committed writes** (exactly the kind of silent corruption Risk 6 exists to prevent).

better-sqlite3 (already a dependency, v12.11.1) ships an online-backup API that handles this correctly:

```
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(typeof db.backup);"
# → function
```

`db.backup(destPath)` (see `node_modules/better-sqlite3/lib/methods/backup.js`) uses SQLite's C backup API, which reads through the WAL consistently while the source connection stays open and usable — no manual checkpoint step, no risk of a torn read. This is the correct primitive for implementing Risk 6, not a raw file copy.

## Other considerations surfaced for whoever specs/implements this (change-control required — not actioned here)

1. **Trigger cadence, not just "startup".** `lib/db.ts` executes on every module import. In `next dev` (Turbopack), that module can be re-evaluated across hot reloads, not just true process starts — a literal "on every import" trigger would spam `data/backups/` far faster than "keep last 7 daily" implies. The spec will need to define "startup" as either (a) once-per-calendar-day (skip if today's dated file already exists — the `YYYYMMDD` naming in Risk 6 already supports this idempotency check for free), or (b) gated to production `next start` only.
2. **Rotation logic** (keep last 7) is unwritten today — needs listing `data/backups/*.db`, sorting by embedded date, deleting beyond the newest 7. Cheap, no open design question.
3. **Restore drill** — the frontier item's done-milestone requires a scratch-copy restore drill validated against `db-integrity.sh` (per `resale-inventory-diagnostics-and-tooling` / `resale-inventory-validation-and-qa`). Not attempted in this session; this is an implementation-time step, not a research one.

## Why this still blocks nothing else

This item has no dependency on the AC3 Listed→Sold contradiction or on D2 (import 500s) — it is purely additive risk retirement, which is why the frontier skill ranks it first. The two design notes above (backup primitive choice, trigger cadence) are the only things a future implementer needs beyond plan.md Risk 6 as written; both should go through `resale-inventory-change-control` before code is written, since this is a new startup side effect.

## Suggested next problem for this research thread

Frontier item 2 (sale-event ingestion) is explicitly gated on an owner-supplied platform report sample and is not investigable further without that artifact. Frontier item 1 (pricing intelligence) sufficiency instrument was last measured 0/0 (2026-07-02); re-running it read-only is cheap and worth doing on the next iteration to check whether the flywheel has any new data yet, even though the heuristic work itself stays blocked.
