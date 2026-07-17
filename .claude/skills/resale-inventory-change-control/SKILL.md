---
name: resale-inventory-change-control
description: Governs how changes are made to the resale-inventory repo (formerly resale-inventory) — spec-first authority order, change classification gates, non-negotiable rules, schema-migration protocol, and git/commit policy. Load before editing any code, spec, or schema in this repo; when asked "can I change X", "how do I add a status/condition/column", "should I update requirements.md first", "can I commit this", or before any behavior-changing, schema, or security-touching edit.
---

# resale-inventory Change Control

Runbook for making any change to `/Users/prestonbernstein/dev/resale-inventory` — a local-first multi-category (books + clothing) resale inventory app (Next.js 15 App Router + better-sqlite3, sole operator, no CI, has lint (`npm run lint` via ESLint), has git history). This skill defines WHO decides, WHAT order changes happen in, and WHICH rules are never broken. It does not teach the architecture (see `resale-inventory-architecture-contract`) or how to debug (see `resale-inventory-debugging-playbook`).

**Terms used once, then assumed:**
- **Spec folders** = `docs/book-inventory-management/` (the original books-only spec — `requirements.md` 22 FRs/11 ACs, `plan.md`, `steps.md`, `TASKS.md` execution record 17/17 done 2026-07-01, `challenge-notes.md`) **plus** `docs/multi-category-inventory/` (the later books+clothing migration spec, same four-file shape, `TASKS.md` generated 2026-07-11). The multi-category spec extends and consolidates the API/UI surface (`app/api/books/**`+`app/books/**` → `app/api/items/**`+`app/inventory/**`) but explicitly keeps the original book spec's data model and behavioral guarantees "in force unchanged" (`docs/multi-category-inventory/requirements.md`). Treat both folders as change-control authority together; for anything touching category-agnostic behavior (statuses, money, transitions), check both.
- **The DB** = `data/inventory.db` — the operator's inventory database. Currently holds only a single "Test Book" fixture row (never used for real production inventory) but the sacred-DB rules below apply regardless of what's in it — never treat it as disposable just because it's thin today.
- **Constraint leak** = a DB CHECK constraint violation surfacing as HTTP 500 instead of a validated 422. This was the project's live defect cluster (D1/D2/D3/D4) — **all four are now FIXED** (2026-07-03; see `resale-inventory-constraint-leak-campaign` for the completed campaign and `resale-inventory-failure-archaeology` for the fix record). The pattern and its fix methodology remain the reference for any *new* constraint-leak defect.

## 1. Authority model

**ASSUMPTION (coordinator-approved, load-bearing):** the spec folder is the change-control authority for this repo. Behavior changes require a spec update FIRST, then code.

Order of precedence when documents disagree:

| Rank | Document | Role |
|---|---|---|
| 1 | `requirements.md` | WHAT the system must do (FRs, ACs, constraints) |
| 2 | `plan.md` | HOW it does it (schema, API contract, security) |
| 3 | `steps.md`, `TASKS.md` | Execution record — history, not authority |
| 4 | Code | Implementation — must follow the above |

**Procedure for any behavior change:** update the FR/AC in `requirements.md` → update `plan.md` (API contract / schema / security section as applicable) → change code + tests → record the change in `TASKS.md`.

**Exception currently in force — the AC3 contradiction.** `challenge-notes.md` "Open questions" records an unresolved conflict: AC3 implies a direct Listed → Sold transition; FR10 and `lib/transitions.ts` enforce two-step Listed → Sale Pending → Sold. `requirements.md` was never reconciled. Until the owner arbitrates, **shipped code behavior (two-step) is the operating authority** for this one question. Changing either side — the AC or the transition map — requires an explicit owner decision. Do not "fix" AC3 or add Listed → Sold on your own authority.

## 2. Change classification and gates

There is no CI, no PR pipeline. ESLint (`npm run lint`) exists but isn't a gate this section enumerates separately — treat a clean `npm run build` as covering it unless a change specifically touches lint config. "Merge-equivalent" here means: the evidence below exists before you call the change done. HTTP-level verification means a GET-only probe, the safe-test procedure from `resale-inventory-validation-and-qa`, or — when the behavior under test is itself mutating — a gated mutating probe under a campaign-style protocol (operator backup first, `CAMPAIGN-PROBE`-tagged rows, verified cleanup; the reference protocol is `resale-inventory-constraint-leak-campaign`). Never ad-hoc mutating requests against the live DB, and **never a raw `npx vitest run`** (see non-negotiable (e)).

| Class | Examples | Required gate before done |
|---|---|---|
| Docs-only | Fix typo in `plan.md`, clarify FR wording | None beyond the AC3 exception above; note material spec edits in `TASKS.md` |
| Non-behavioral refactor | Dedupe a constant, extract helper, rename internal fn | `npm run build` green (route surface now spans `app/api/items/**` (10 routes), `app/api/{dashboard,export,import,isbn}`, and pages under `app/`, `app/inventory/`, `app/dashboard/`, `app/playbook/` — a route-count regression is a finding, don't hardcode a magic number); safe-test procedure from `resale-inventory-validation-and-qa`; no API response byte should change |
| Behavior-changing | Status codes, validation rules, API contract, transition map, response shapes | Spec updated FIRST (FR/AC then plan.md contract); build green; safe tests; **HTTP-level verification of the new behavior** (drive the endpoint, read the actual status code); `TASKS.md` entry |
| Schema migration | New column, CHECK change, enum extension, index | All of the above PLUS the schema-change protocol in section 4; `plan.md` Data model section updated to match |
| Security-touching | CSRF middleware, input bounds, error-message handling, anything in plan.md Security section | All behavior-change gates PLUS explicit check against every bullet in `plan.md` "Security"; owner sign-off for anything that widens exposure (e.g., binding beyond localhost) |

When in doubt between two classes, apply the stricter gate.

## 3. Non-negotiables

Rules that no change may violate, each earned by a real incident or spec constraint:

| # | Rule | Rationale | Historical incident / source |
|---|---|---|---|
| a | Never store derived money values (`gross_profit` especially) | Derived + stored = drift and truncation; SQL computes it at read time | `challenge-notes.md`: original Step 9 divided by 100 before storing, truncating small profits to 0 cents — the stored `gross_profit` column was removed in adversarial review |
| b | Never bypass `lib/transitions.ts`; never add/remove a transition without editing FR10 and updating the full transition test matrix | The transition map is spec-enumerated (FR10) and the sole guard against invalid lifecycle states | FR10 exists because the pre-review spec ("prevent logically invalid transitions", one example) was untestable — `challenge-notes.md` |
| c | `acquisition_cost` and sale fields (`sale_price`, `sale_platform`, `sale_date`) are immutable once status = Sold | Audit integrity — sold records are the P&L record | `requirements.md` Constraints: "must not be editable after an item reaches Sold status (audit integrity)" |
| d | Never weaken or drop DB CHECK constraints to silence HTTP 500s | The CHECKs are the last line of data integrity; the 500s are a validation-layer gap, not a schema bug. Correct fix = validate before write, return 422 | Historical: four verified constraint leaks (D1/D2/D3/D4, 2026-07-02/03) — status→Listed without `listing_price`; CSV import with duplicate ISBN losing the whole batch; PATCH `listing_price:null` on a Listed item; Sold response omitting `gross_profit`. All FIXED 2026-07-03 with route-level pre-validation, not constraint-weakening. Campaign record: `resale-inventory-constraint-leak-campaign` |
| e | Never run `npx vitest run` (or any full test run) without the safe procedure in `resale-inventory-validation-and-qa` | `tests/integration.test.ts` (~line 139) executes `DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;` — this trap is now mitigated (not eliminated) by `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` env vars (`lib/db.ts`, `lib/photos.ts`) which `vitest.config.ts` sets to scratch locations for every test run; a raw `vitest run` invoked OUTSIDE that config (or any ad hoc script importing `lib/db.ts` without the env vars set) still resolves to `data/inventory.db` via `process.cwd()` and wipes it | Verified against current `tests/integration.test.ts` and `vitest.config.ts` |
| f | All SQL via better-sqlite3 prepared statements with `?` placeholders; never interpolate user input | SQL injection | `plan.md` Security section (added in adversarial review) |
| g | Never delete, recreate, or write to `data/inventory.db` (or its `-wal`/`-shm` files) outside the app itself | Sole copy of inventory data. A startup backup routine now exists (`lib/backup.ts`, `runStartupBackup` called from `lib/db.ts`) — snapshots to `data/backups/inventory-YYYYMMDD.db` via the WAL-safe online backup API, keeps the newest 7 — but it's a safety net, not a license to write directly | ASSUMPTION (coordinator-approved): DB is sacred regardless of backups existing. Read-only inspection: `sqlite3 "file:/Users/prestonbernstein/dev/resale-inventory/data/inventory.db?mode=ro" "..."` — DB care and backups: `resale-inventory-run-and-operate` |
| h | All monetary I/O goes through `lib/money.ts` (integer cents, string arithmetic, half-up rounding, 100,000,000-cent cap) | One missed decimal↔cents conversion silently corrupts data | `plan.md` Risk 2; `lib/money.ts` verified 2026-07-02 |

## 4. Schema-change protocol

Current reality (verified by reading `lib/db.ts`): the module resolves the DB path (`BOOKSELLER_DB_PATH` env var, else `data/inventory.db` under `process.cwd()`), opens it, sets `journal_mode=WAL` and `foreign_keys=ON`, then runs a **versioned migration runner**: a `VERSIONED_MIGRATIONS` array of `{ version, file }` pairs, gated by `PRAGMA user_version`. Each migration whose `version` exceeds the current `user_version` runs once, inside a `db.transaction()`, and bumps `user_version` to match. This runner was itself built in response to a past finding that there was no migration runner (see `resale-inventory-failure-archaeology`) — three migrations now ship: `001_init.sql` (v1), `002_price_history_nullable.sql` (v2), `003_multi_category.sql` (v3, the books→items rebuild that introduced `items`/`book_details`/`clothing_details`/`item_photos`/`item_platforms` and archived `books`/`book_platforms` to `books_archived`/`book_platforms_archived`).

Consequences for any schema change:

1. **Write a new numbered migration file** in `data/migrations/` (e.g., `004_<slug>.sql`). Never edit an already-shipped migration file in place — `001_init.sql` in particular uses `CREATE TABLE IF NOT EXISTS books/book_platforms/...`, which is now dead code protected only by staying gated behind `user_version < 1` (see the comment block at the top of `lib/db.ts`) — running it unconditionally on an already-migrated DB would silently resurrect empty `books`/`book_platforms` tables next to their `*_archived` counterparts.
2. **CHECK/enum changes require the table-rebuild pattern**: SQLite cannot alter inline CHECK constraints. Create the new table, copy rows, drop the old table, rename — inside one transaction. `003_multi_category.sql` is the reference example, including a documented gotcha worth re-reading before writing another rebuild: a column-rename-only approach was tried first for `price_history.book_id → item_id` and found to leave the FK's *referenced table* still pointing at the old table name (SQLite's rename propagation retargets to wherever the old table got renamed, not to the new one) — only a full create-copy-drop-rename fixed it. Archive-don't-drop is also the pattern for the superseded table itself (`books`/`book_platforms` → `*_archived`, not dropped) — cheap rollback path, no backup-restore required if a problem surfaces post-migration.
3. **Register the new migration** by appending `{ version: N, file: 'NNN_slug.sql' }` to the `VERSIONED_MIGRATIONS` array in `lib/db.ts` — the runner itself doesn't need new code, just the new entry. Still classify this as a schema-migration change (this section) and gate accordingly; it changes the DB on next boot.
4. Migration files execute **at most once per DB** (idempotent by construction via `PRAGMA user_version`) — do not also hand-roll `IF NOT EXISTS`/idempotency guards inside new migration SQL; the runner already provides that.
5. Before any migration touches a DB with real data: take a backup first (`lib/backup.ts` runs one automatically on startup, but don't rely on timing — take an explicit one; procedure in `resale-inventory-run-and-operate`). Sessions never migrate a real/live DB autonomously.
6. Update `plan.md` (in the relevant spec folder — `docs/book-inventory-management/` or `docs/multi-category-inventory/`) Data model section to match the post-migration schema in the same change.

## 5. Git and commit policy

The zero-commit baseline this section originally described is gone — the repo now has real history on `main` (initial commit `2ebb1ae "Initial commit: book inventory management app"` through the multi-category migration and UX polish work; `git log --oneline` to see the current tip).

- Committing is still not something a session does unless asked. Sessions must not `git init` workflows, commit, or push autonomously — not even "helpfully" snapshotting before a change.
- When the owner does commit: commits are **owner-attributed**. Do not add AI authorship attribution, co-author trailers, or generated-by lines to any commit you are asked to make.
- With a real history now established, your safety nets are (a) not touching the DB, (b) `git status`/`git diff` before and after any edit, and (c) the spec folders' `.bak` files for pre-review originals. Act accordingly: small, verified edits, and don't assume an uncommitted change is trivially recoverable — check `git status` before starting.

## 6. Checklists

### Pre-change checklist (run before editing anything)

```
[ ] Classified the change (section 2) — docs-only / refactor / behavior / schema / security
[ ] If behavior-changing: identified the exact FR/AC in requirements.md and the plan.md
    contract section that must change first
[ ] Checked the change doesn't touch the AC3 contradiction (Listed→Sold) — if it does, STOP,
    needs owner decision
[ ] Checked the change against all 8 non-negotiables (section 3)
[ ] If schema: read lib/db.ts to confirm current migration state; drafted the numbered
    migration + rebuild plan (section 4)
[ ] Confirmed no step requires running the raw test suite, mutating HTTP calls, or writing
    to data/inventory.db
[ ] If the change area is a known defect (constraint-leak 500s, import duplicate-ISBN),
    read resale-inventory-constraint-leak-campaign first — don't fix ad hoc
```

### Pre-"done" checklist (run before reporting complete)

```
[ ] Spec updated first and matches the shipped behavior (requirements.md → plan.md, in
    whichever spec folder(s) the change touches)
[ ] npm run build green (route surface is app/api/items/**, app/api/{dashboard,export,
    import,isbn}/**, and pages under app/, app/inventory/, app/dashboard/, app/playbook/;
    an unexpected drop in route count is a finding, not noise)
[ ] Safe-test procedure from resale-inventory-validation-and-qa executed — NOT raw npx vitest run
[ ] For API behavior: verified at HTTP level, actual status code read from a real response
    (dev server binds to 127.0.0.1 per middleware/security posture — confirm actual port from
    the dev server's own output, don't assume :3000)
[ ] TASKS.md updated with what changed and why (in the relevant spec folder)
[ ] data/inventory.db untouched (mtime check if paranoid); no commits made unless asked
[ ] Duplicated constants kept in sync if touched — condition vocabularies (BOOK_CONDITIONS,
    CLOTHING_CONDITIONS) and DATE_RE are now centralized in lib/constants.ts (single source
    for TS consumers) and ISBN normalization is centralized in lib/isbn.ts (normalizeISBN) —
    but the SQL CHECK constraints in data/migrations/*.sql encode the same vocabularies
    independently (SQLite can't import a TS module) and must be kept in sync by hand any
    time a condition value changes
```

## 7. When NOT to use this skill

- **Understanding the design, invariants, or why the system is shaped this way** → `resale-inventory-architecture-contract`
- **A symptom is in front of you and you need triage** → `resale-inventory-debugging-playbook`
- **History of a specific past defect** → `resale-inventory-failure-archaeology`
- **The constraint-leak methodology** (D1-D4 are FIXED, but the campaign is the reference for diagnosing a *new* CHECK-constraint-vs-route-validation gap) → `resale-inventory-constraint-leak-campaign` (this skill only tells you the gates around that kind of work)
- **How to test safely / what evidence counts** → `resale-inventory-validation-and-qa`
- **Running the app, DB backups, operational care** → `resale-inventory-run-and-operate`
- **Build, environment, Node/Next specifics** → `resale-inventory-build-and-env`
- **Where a constant lives / config values** → `resale-inventory-config-and-constants`
- **Writing docs or spec-file templates** → `resale-inventory-docs-and-writing`
- **Book-domain questions** (condition grades, platforms) → `bookselling-domain-reference`
- **Diagnostic scripts and tooling** → `resale-inventory-diagnostics-and-tooling`

Use this skill only when the question is "am I allowed to make this change, in what order, and what proves it's done."

## Provenance and maintenance

Authored 2026-07-02, content-refreshed 2026-07-12 from direct inspection of the current repo (both spec folders' requirements.md/plan.md/TASKS.md, lib/db.ts, lib/backup.ts, lib/transitions.ts, lib/constants.ts, lib/isbn.ts, middleware.ts, package.json, data/migrations/*.sql, git log). Items labeled ASSUMPTION are coordinator-approved, not repo-verified.

Re-verify volatile facts before relying on them:

- Git history exists: `cd /Users/prestonbernstein/dev/resale-inventory && git log --oneline | wc -l` (expect a real count, not a "does not have any commits yet" error)
- Versioned migration runner: `grep -n "VERSIONED_MIGRATIONS" /Users/prestonbernstein/dev/resale-inventory/lib/db.ts` (expect the array, keyed off `PRAGMA user_version`)
- Migration count: `ls /Users/prestonbernstein/dev/resale-inventory/data/migrations/` (expect `001_init.sql`, `002_price_history_nullable.sql`, `003_multi_category.sql` — a 4th file means a schema change shipped since this was last checked)
- Test-suite DB-wipe trap still present (but mitigated by env-var redirection): `grep -n "DELETE FROM" /Users/prestonbernstein/dev/resale-inventory/tests/integration.test.ts` (any hit = trap live in that file; confirm `vitest.config.ts` still sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` to scratch paths — do NOT run the suite to check)
- CSRF middleware present: `cat /Users/prestonbernstein/dev/resale-inventory/middleware.ts` (expect an Origin-header check on mutating methods, matcher `/api/:path*`)
- Startup backup routine present: `cat /Users/prestonbernstein/dev/resale-inventory/lib/backup.ts` (expect `runStartupBackup`, 7-file retention, `db.backup()`)
- AC3 contradiction still open: `grep -n "AC3" /Users/prestonbernstein/dev/resale-inventory/docs/book-inventory-management/challenge-notes.md` (open question section) — cross-check current status in `resale-inventory-failure-archaeology` (SR-6)
- Route surface: `find /Users/prestonbernstein/dev/resale-inventory/app -name "page.tsx" -o -name "route.ts"` (expect items/dashboard/export/import/isbn API routes and inventory/dashboard/playbook pages under app/ — no app/api/books or app/books)
- Transition map unchanged: `grep -n "Sale Pending" /Users/prestonbernstein/dev/resale-inventory/lib/transitions.ts` (Listed→Sold must NOT appear as allowed)
