---
name: book-seller-failure-archaeology
description: Historical record of every known defect, dead-end, rejected design, and near-miss in the book-seller repo. Consult when asking "has this been tried before", "why is X like this", "known issues", "past bugs", "is this a known problem", "why is there no gross_profit column", "why did import return 500", or before proposing a design change or filing a new bug. Also the single place to APPEND new failure entries.
---

# Book-Seller Failure Archaeology

The institutional memory of what went wrong, what almost went wrong, and what was
deliberately rejected in `/Users/prestonbernstein/dev/book-seller`. Read the relevant
Chronicle entry **before** debugging a symptom listed here, re-proposing a design, or
assuming a behavior is intentional.

## Why this file exists (the sources situation)

**There is no git history to mine.** The repo has a `.git` directory but **zero
commits** (`git log` → `fatal: your current branch 'main' does not have any commits
yet`, verified 2026-07-02). You cannot `git blame`, `git log`, or `git bisect` your
way to "why is X like this". This archive is reconstructed from the only sources that
exist:

| Source | What it tells you |
|---|---|
| `docs/book-inventory-management/requirements.md`, `plan.md`, `steps.md` | Current spec — the change-control authority for this feature (per coordinator decision; see sibling skill `book-seller-change-control`) |
| `*.bak` files in the same folder | Pre-review originals from 2026-07-01. `diff <file>.bak <file>` shows exactly what the adversarial spec review changed |
| `docs/book-inventory-management/challenge-notes.md` | The spec-review record: 7 agents, ~39 findings, what was accepted/rejected, open questions |
| `docs/book-inventory-management/TASKS.md` | Implementation tracker, 17/17 tasks marked done 2026-07-01 |
| Live probes, 2026-07-02 | Principal engineer's HTTP transcripts against the running app (quoted verbatim in entries below). **Do not re-run the mutating reproductions** — they write to the real DB |

### What the .bak diffs show (run these yourself; both are read-only)

```sh
cd /Users/prestonbernstein/dev/book-seller/docs/book-inventory-management
diff requirements.md.bak requirements.md
diff plan.md.bak plan.md
```

Summary of what the 2026-07-01 review changed (verified by running the diffs):

- **requirements.md**: vague FR9-era "prevent logically invalid transitions" replaced by
  FR10's full transition enumeration + FR11 (Sale Pending semantics); FR15 defines
  "held"; FR13 pins search-match semantics per field; FR21 defines the import schema's
  required columns; FR22 requires per-row import errors without aborting the batch;
  AC8 clarified (terminal statuses excluded from held totals).
- **plan.md**: `platforms TEXT` (comma-separated) column replaced by a
  `book_platforms` junction table; stored `gross_profit INTEGER` column **deleted**
  (compute at read time); WAL + `foreign_keys` pragmas mandated in `lib/db.ts`;
  `idx_books_isbn` became **UNIQUE**; four status-consistency `CHECK` constraints added
  to `books` (these later became Defect D1's trigger); an entire **Security** section
  (10 mitigations, incl. localhost binding and Origin-header CSRF middleware) added;
  Risks 6–8 added (startup backup routine, enum-extension cost, import field behavior);
  409-on-duplicate-ISBN contract added to POST /api/books.

## Status vocabulary

| Status | Meaning |
|---|---|
| OPEN | Confirmed problem, not yet fixed |
| SUSPECTED | Plausible from code reading; never reproduced |
| FIXED-BY-DESIGN | Caught in spec review 2026-07-01, before any code existed |
| ACCEPTED-GAP | Known deviation, judged tolerable for a sole-seller local app; fix only if it starts to hurt |
| OWNER-DECISION-PENDING | Blocked on a decision from the repo owner |
| ENVIRONMENTAL | Property of the dev machine, not the code; permanent caution |

---

## The Chronicle

Index (each entry is self-contained below):

| ID | Date | One-line symptom | Status |
|---|---|---|---|
| SR-1 | 2026-07-01 | Stored gross_profit column would truncate small profits to 0 | FIXED-BY-DESIGN |
| SR-2 | 2026-07-01 | Comma-separated platforms column | FIXED-BY-DESIGN |
| SR-3 | 2026-07-01 | SQLITE_BUSY under concurrent App Router handlers | FIXED-BY-DESIGN |
| SR-4 | 2026-07-01 | Untestable status-transition requirement | FIXED-BY-DESIGN |
| SR-5 | 2026-07-01 | Implementation Realist review agent died — feasibility angle unreviewed | ACCEPTED-GAP |
| SR-6 | 2026-07-01 | AC3 contradicts FR10 on Listed→Sold | OWNER-DECISION-PENDING |
| D1 | 2026-07-02 | Status transition to Listed without listing_price → HTTP 500, spec says 422 | FIXED (2026-07-03) |
| D2 | 2026-07-02 | CSV import with one duplicate ISBN → HTTP 500, zero rows imported | FIXED (2026-07-03) |
| D3 | 2026-07-03 | PATCH `{"listing_price": null}` on a Listed item → HTTP 500 | FIXED (2026-07-03) |
| T1 | 2026-07-02 | `npx vitest run` wipes the real inventory DB | MITIGATED (Task 22) |
| T2 | 2026-07-02 | curl :3000 silently hits an unrelated Flutter app | ENVIRONMENTAL |
| DR-1 | 2026-07-02 | No middleware.ts — CSRF Origin check unimplemented | FIXED (Task 23) |
| DR-2 | 2026-07-02 | No startup backup routine (plan Risk 6) | FIXED (Task 24) |
| DR-3 | 2026-07-02 | ISBN lookup returns 404 on timeout; plan says 503 | FIXED (Task 25) |
| DR-4 | 2026-07-02 | dev script does not bind 127.0.0.1 | FIXED |
| DR-5 | 2026-07-02 | Export builds whole CSV in memory; plan says streaming | ACCEPTED-GAP |
| DR-6 | 2026-07-02 | lib/types.ts is a stub | ACCEPTED-GAP |
| DR-7 | 2026-07-02 | price_history stores previous_price 0 instead of NULL | FIXED |
| D4 | 2026-07-03 | POST /api/books/:id/status Sold response omits gross_profit | FIXED (Task 20) |
| DR-8 | 2026-07-03 | AC9 HTTP test's CSV header uses acquisition_cost, not acquisition_cost_usd — every row fails validation | FIXED (Task 20) |

Baseline health at time of writing (2026-07-02): `npx vitest run` → 139 passed,
15 skipped (a `describe.skip` HTTP API suite needing a live server + 1 network ISBN
test) — **but see T1 before ever running it**. `npm run build` → green, 13 routes.

---

### SR-1 | 2026-07-01 | Stored gross_profit column (Step 9 truncation bug)

- **Symptom**: Pre-review plan stored `gross_profit INTEGER -- cents; computed once on → Sold` as a `books` column. The pre-review Step 9 divided by 100 **before** storing, truncating small profits to 0.
- **Root cause**: Redundant stored derivation of `sale_price - acquisition_cost`, plus a unit-conversion-order bug in the step that wrote it.
- **Evidence**: `diff plan.md.bak plan.md` in `docs/book-inventory-management/` (removes the `gross_profit` column line, adds "`gross_profit` is computed at read time … and never stored"); `challenge-notes.md` "Changes made" bullet 2. Shipped code confirms: `app/api/books/[id]/route.ts` and `app/api/export/route.ts` compute `CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END` in SQL; `data/migrations/001_init.sql` has no gross_profit column.
- **Status**: FIXED-BY-DESIGN (caught before any code existed).
- **Routed-to**: Rejected-designs register below. Do not re-propose a stored column.

### SR-2 | 2026-07-01 | Comma-separated platforms column

- **Symptom**: Pre-review schema had `platforms TEXT -- comma-separated e.g. "Amazon,eBay"` on `books`.
- **Root cause**: Multi-platform listing was a silent design assumption crammed into one column — unqueryable, no FK, no per-platform timestamp.
- **Evidence**: `diff plan.md.bak plan.md` (column removed; `book_platforms(id, book_id, platform, listed_at)` table + `idx_bp_book` added); `challenge-notes.md` bullet 1. Shipped: `data/migrations/001_init.sql` contains `book_platforms`; routes join it and serialize `platforms: string[]`.
- **Status**: FIXED-BY-DESIGN.
- **Routed-to**: Rejected-designs register. Schema questions → `book-seller-architecture-contract`.

### SR-3 | 2026-07-01 | SQLITE_BUSY risk under concurrent handlers

- **Symptom** (predicted, never shipped): Next.js App Router runs handlers concurrently; default SQLite journal mode would throw `SQLITE_BUSY` under any parallel request load.
- **Root cause**: Pre-review plan omitted WAL mode and FK enforcement.
- **Evidence**: `challenge-notes.md` bullet 3; `diff plan.md.bak plan.md` adds the pragma requirement. Shipped: `lib/db.ts:14-15` runs `db.pragma('journal_mode = WAL')` and `db.pragma('foreign_keys = ON')`. The `-wal`/`-shm` files next to `data/inventory.db` confirm WAL is live.
- **Status**: FIXED-BY-DESIGN.
- **Routed-to**: `book-seller-architecture-contract` for DB-layer invariants.

### SR-4 | 2026-07-01 | Untestable status-transition requirement

- **Symptom**: Pre-review FR9 said "prevent logically invalid transitions (e.g., Sold → Listed)" — one example, no enumeration; untestable.
- **Root cause**: Requirement written as intent, not as a checkable transition table.
- **Evidence**: `diff requirements.md.bak requirements.md` — new FR10 enumerates every legal transition and names the four terminal states; FR11 defines Sale Pending semantics. Shipped: `lib/transitions.ts` (`ALLOWED_TRANSITIONS`, `assertTransitionAllowed`).
- **Status**: FIXED-BY-DESIGN. But see SR-6 — the enumeration created a contradiction with AC3 that is still open.
- **Routed-to**: `bookselling-domain-reference` for the status lifecycle; `book-seller-change-control` before editing FR10.

### SR-5 | 2026-07-01 | Implementation Realist review agent produced nothing

- **Symptom**: During the 7-agent adversarial spec review, the Implementation Realist agent's connection closed after ~20 minutes with **0 findings**. Triage proceeded with 6/7 agents.
- **Root cause**: Agent connection failure; the review was not re-run for that angle.
- **Evidence**: `challenge-notes.md` "Agents run" section (the Implementation Realist bullet, line 7) and "Critiques rejected" section.
- **Consequence**: The implementation-feasibility angle — exactly the "does the route code actually satisfy the schema's constraints?" class of question — went unreviewed. ASSUMPTION (plausible, unprovable): this gap is why D1 and D2, both implementation-vs-schema mismatches, shipped.
- **Status**: ACCEPTED-GAP (the spec era is over; the lesson is process-level: when a review agent dies, re-run its angle before calling the review complete).
- **Routed-to**: `book-seller-validation-and-qa` for review process; this file for the D1/D2 fallout.

### SR-6 | 2026-07-01 | AC3 contradicts FR10 (Listed → Sold)

- **Symptom**: AC3 in `requirements.md` reads "Given an item in Listed status, when the operator records a sale with price and platform, the item transitions to Sold" — a **direct** Listed→Sold. FR10 permits only Listed → Sale Pending → Sold.
- **Root cause**: FR10's full enumeration (SR-4) was added without reconciling AC3's wording.
- **Evidence**: `requirements.md` FR10 (line 23) vs AC3; `challenge-notes.md` "Open questions requiring human input" spells out options (a) fix AC3, (b) add Listed→Sold to FR10. Shipped `lib/transitions.ts` follows FR10 — no direct Listed→Sold.
- **Status**: OWNER-DECISION-PENDING. Until the owner decides, **code (= FR10 behavior) is the operating authority**. Do not "fix" either side unilaterally.
- **Routed-to**: `book-seller-change-control` (this is a spec change, not a bug fix).

### D1 | 2026-07-02 | Transition to Listed without listing_price → HTTP 500

- **Symptom**: Legal FR10 transition (Unlisted→Listed) on a book with no listing price returns `500 {"error":"Internal server error."}`. Spec behavior for a client-input problem is 422.
- **Reproduction transcript** (principal engineer, 2026-07-02 — **do not re-run**, it writes real rows):
  1. `POST /api/books` `{"title":"Probe Book","author":"Tester","condition":"Good","acquisition_cost":500,"acquisition_date":"2026-07-01"}` → 201, id `349e31b3-…`
  2. `POST /api/books/349e31b3-…/status` `{"status":"Listed"}` → **HTTP 500** `{"error":"Internal server error."}`
- **Root cause**: `data/migrations/001_init.sql:24` — `CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL)` — throws inside the UPDATE. The status route validates the *transition* but never checks *listing_price*, so the SQLite CHECK error falls into the catch-all at `app/api/books/[id]/status/route.ts:118`, which maps everything to 500. A constraint leak: DB enforces an invariant the route never pre-validates.
- **Status**: FIXED (2026-07-03). `app/api/books/[id]/status/route.ts` now fetches `listing_price` alongside `status` and, before attempting the transition, checks `(toStatus === 'Listed' || toStatus === 'Sale Pending') && book.listing_price === null` → `422 {"error":"Cannot list a book without a listing_price. Set a price first via PATCH."}`. Regression transcript (isolated worktree DB, 2026-07-03): `POST /api/books` (no listing_price) → 201; `POST .../status {"status":"Listed"}` → **422** (matches); `PATCH .../{"listing_price":1200}` → 200; retry `POST .../status {"status":"Listed"}` → **200**, status Listed. Also added defense-in-depth: outer catch maps `err.code === 'SQLITE_CONSTRAINT_CHECK'` → 422 and `SQLITE_CONSTRAINT_UNIQUE'` → 409 (Solution B, `book-seller-constraint-leak-campaign`). Locked in by `tests/integration.test.ts` "D1: POST status Listed without listing_price → 422 (not 500); succeeds after PATCH sets a price" (HTTP suite, still `describe.skip` by default — activate per `book-seller-validation-and-qa`). Spec updated first: `requirements.md` FR23, `plan.md` API contract for `POST /api/books/:id/status`.
- **Routed-to**: `book-seller-constraint-leak-campaign` (the fix); `book-seller-debugging-playbook` (triage of new 500s).

### D2 | 2026-07-02 | CSV import with duplicate ISBN → 500, whole batch lost

- **Symptom**: Import of a 3-row CSV (rows 1+2 share ISBN `9780306406157`, row 3 valid with no ISBN) → `HTTP 500 {"error":"Internal server error"}` and **0 rows imported** (verified by `GET /api/books` afterwards). Violates FR22 (report per-row errors without aborting the batch) and AC9 (import valid rows, report errors with row numbers).
- **Reproduction transcript** (principal engineer, 2026-07-02 — **do not re-run**): `POST /api/import` with the CSV above → 500, then `GET /api/books` shows none of the 3 rows.
- **Root cause** (all in `app/api/import/route.ts`):
  - Line 137: does its own "basic" ISBN cleanup (`rawIsbn.replace(/[^0-9X]/gi, '')`) instead of calling `normalizeISBN` from `lib/isbn.ts` — no ISBN-10→13 conversion, no format validation.
  - No duplicate check against existing rows or within the batch.
  - Lines 159–165: all valid rows inserted in **one** `db.transaction`; the partial unique index `idx_books_isbn` (`data/migrations/001_init.sql:30`, `WHERE isbn IS NOT NULL`) throws on the duplicate, the whole transaction rolls back, and the catch-all at line 170 returns 500.
- **Status**: FIXED (2026-07-03). `app/api/import/route.ts` now calls `normalizeISBN` per row (invalid format → per-row error), tracks an in-file `Set<string>` of seen normalized ISBNs (dup-in-file → per-row error), and runs one prepared `SELECT id FROM books WHERE isbn = ?` per candidate (dup-vs-DB → per-row error); valid rows still commit in a single transaction (FR22 wording preserved). Regression transcript (isolated worktree DB, 2026-07-03, ISBN `9780306406157` not pre-existing): `POST /api/import` with the 3-row dup-ISBN fixture → **200** `{"imported":2,"errors":[{"row":3,"fields":["isbn"],"message":"Duplicate ISBN \"9780306406157\": already present earlier in this file."}]}` (matches Phase 5 prediction exactly — row A + row C imported, row B's duplicate reported by its own row number). Also added the same `SQLITE_CONSTRAINT_CHECK`/`SQLITE_CONSTRAINT_UNIQUE` defense-in-depth mapping as D1. Locked in by `tests/integration.test.ts` "D2: POST /api/import with a duplicate ISBN reports a per-row error and still imports the other valid rows...". Spec updated first: `requirements.md` FR22 extended + AC12 added, `plan.md` API contract for `POST /api/import`.
- **Routed-to**: `book-seller-constraint-leak-campaign`.

### D3 | 2026-07-02 | CONFIRMED 2026-07-03: PATCH `{"listing_price": null}` on a Listed item → 500

- **Symptom**: clearing the listing price of a Listed or Sale Pending item returns 500.
- **Reasoning from code** (`app/api/books/[id]/route.ts`): PATCH explicitly allows `listing_price: null` ("allow clearing to null") and writes NULL. If `status` is Listed/Sale Pending, the same CHECK as D1 (`001_init.sql:24`) fires in the UPDATE, and the route's catch-all returns 500.
- **Reproduction transcript** (constraint-leak-fix campaign session, 2026-07-03, isolated worktree DB — throwaway copy, not the real DB, cleaned up after):
  1. `POST /api/books` `{"title":"CAMPAIGN-PROBE-2026-07-03-D3", ...}` → 201, id `5e210d9b-9b29-4079-8551-90e7fff15bad`
  2. `PATCH /api/books/5e210d9b-.../` `{"listing_price": 1500}` → 200
  3. `POST /api/books/5e210d9b-.../status` `{"status":"Listed"}` → 200
  4. `PATCH /api/books/5e210d9b-.../` `{"listing_price": null}` → **HTTP 500** `{"error":"Internal server error."}` (predicted before running, matched exactly)
- **Status**: FIXED (2026-07-03). `app/api/books/[id]/route.ts` PATCH now checks, when `listing_price === null` is requested, whether `current.status` is `Listed` or `Sale Pending`; if so returns `422 {"error":"Cannot clear listing_price while status is Listed or Sale Pending. Transition the item first."}` before attempting the write (clearing is still allowed for Unlisted/Sold/Removed/Donated/Discarded). Regression transcript (isolated worktree DB, 2026-07-03): probe book PATCHed to `listing_price:1500`, transitioned to Listed, then `PATCH .../{"listing_price":null}` → **422** (predicted before running, matched exactly). Same `SQLITE_CONSTRAINT_CHECK`/`SQLITE_CONSTRAINT_UNIQUE` defense-in-depth added to this route's catch. Locked in by `tests/integration.test.ts` "D3: PATCH listing_price null on a Listed item → 422 (not 500)". Spec updated first: `requirements.md` FR24, `plan.md` API contract for `PATCH /api/books/:id`.
- **Routed-to**: `book-seller-constraint-leak-campaign` (fix alongside D1 — same constraint).

### T1 | 2026-07-02 | DB-WIPE TRAP: `npx vitest run` deletes real inventory

- **Symptom**: Running the test suite from the repo root empties `books`, `book_platforms`, and `price_history` in the **production** database.
- **Root cause**: `tests/integration.test.ts:137-138` — the "DB integration" describe's `beforeEach` runs `db.exec('DELETE FROM price_history; DELETE FROM book_platforms; DELETE FROM books;')` — and `lib/db.ts:5` builds the DB path from `process.cwd()` (`data/inventory.db`). There is no test-database indirection. Same data file, real deletes.
- **Evidence**: Verified by code reading 2026-07-02. As of that date the DB contained only test residue (one row: 'Test Book', Listed), so **no real data has been lost yet** — but the trap is armed and will fire the first time real inventory exists.
- **Rule**: **NEVER run `npx vitest run` (or any command that imports `lib/db.ts` with cwd = repo root) while real data exists.** Inspect data read-only: `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT count(*) FROM books;"`
- **Status**: MITIGATED (Task 22, 2026-07-03) — `lib/db.ts` now resolves via `process.env.BOOKSELLER_DB_PATH ?? cwd default`, so the axis to point tests at a throwaway file exists. Not fully closed: nothing in the committed test setup sets the var yet, so `npx vitest run` from repo root with it unset **still wipes the real DB**. The rule below remains in force until a vitest setup file wires the override in by default.
- **Routed-to**: was `book-seller-validation-and-qa` (test isolation); `book-seller-run-and-operate` (data safety). Follow-up (wire the env var into vitest config so procedure B is no longer needed) not yet scheduled.

### T2 | 2026-07-02 | PORT TRAP: :3000 is an unrelated Flutter app

- **Symptom**: `curl http://localhost:3000/...` returns HTTP 200 with Flutter HTML — a silent wrong-target. Probes "succeed" against the wrong app.
- **Root cause**: On this dev machine port 3000 is usually occupied by an unrelated Flutter app; `next dev` auto-falls back to **3001**.
- **Rule**: After starting the dev server, read its startup output for the actual port; sanity-check with a GET whose response you can attribute (e.g. `curl -s http://localhost:3001/api/books | head -c 200` should return JSON, not `<!DOCTYPE html>` Flutter boilerplate). Kill any dev server you start.
- **Status**: ENVIRONMENTAL — permanent caution on this machine, not a code bug.
- **Routed-to**: `book-seller-build-and-env`, `book-seller-run-and-operate`.

### DR-1 | 2026-07-02 | No middleware.ts (CSRF Origin check unimplemented)

- **Symptom/drift**: plan.md Security requires "an `Origin` header check in a Next.js middleware for all POST/PATCH routes". No `middleware.ts` exists at repo root or under `app/` (verified 2026-07-02: `ls middleware.ts app/middleware.ts` → both missing).
- **Root cause**: Task never implemented despite TASKS.md 17/17 done; plausibly SR-5 fallout.
- **Status**: FIXED (Task 23, 2026-07-03) — `middleware.ts` added at repo root, Origin-check on all mutating API requests, `matcher: ['/api/:path*']`. DR-4 (localhost bind) also fixed (Task 21), so both mitigations are now in place. Verified: cross-origin POST/PATCH → 403; same-origin passes through to route validation.
- **Routed-to**: was `book-seller-constraint-leak-campaign`/hardening; fixed per Task 23 in TASKS.md.

### DR-2 | 2026-07-02 | No startup backup routine

- **Symptom/drift**: plan.md Risk 6 specifies a startup copy of `data/inventory.db` to `data/backups/inventory-YYYYMMDD.db`, keeping last 7. `data/backups/` exists but contains only `.gitkeep`; `grep -rn backup lib app` finds no implementation (verified 2026-07-02).
- **Status**: FIXED (2026-07-03, Task 24) — `lib/backup.ts` `runStartupBackup(db, dbPath)`, called fire-and-forget from `lib/db.ts` at boot, snapshots the DB to `data/backups/inventory-YYYYMMDD.db` (keeping newest 7) using better-sqlite3's `db.backup()` (WAL-safe online-backup API, **not** a bare `cp` — see below). Reads the source only; never writes/deletes `inventory.db`/`-wal`/`-shm` (non-negotiable (g)); prune only touches `^inventory-\d{8}\.db$` files. Skipped during `next build` (NEXT_PHASE guard); first-snapshot-of-the-day-wins; failures logged and swallowed so boot never breaks. Regression suite `lib/__tests__/backup.test.ts` (7 tests, in-repo-safe — mkdtemp only) locks in WAL-capture, retention, source-immutability, and the build-skip.
- **Why `db.backup()` not `cp`**: recent committed writes live in `inventory.db-wal` until checkpoint; a plain file copy of `inventory.db` alone can silently lose them (see `book-seller-run-and-operate` data topology). The online-backup API takes a consistent snapshot across the WAL.
- **Routed-to**: `book-seller-run-and-operate` (operational safety).

### DR-3 | 2026-07-02 | ISBN lookup: 404 on timeout, plan says 503

- **Symptom/drift**: `GET /api/isbn/:isbn` returns 404 for provider outage/timeout/oversize responses. plan.md says outages/oversize should return 503.
- **Root cause**: `lib/isbn.ts` `lookupISBN` returned `null` for **every** failure class (timeout, network error, non-OK response, >64 KB body, not-found), so `app/api/isbn/[isbn]/route.ts` could not distinguish "book not found" from "provider down" and mapped everything to 404.
- **Status**: FIXED (2026-07-03, Task 25). `lookupISBN` now returns a discriminated `ISBNLookupResult` (`found` | `not-found` | `invalid` | `unavailable{reason: timeout|network|bad-response|oversize}`); the route maps not-found → 404, unavailable → 503, keeping 400 for invalid format. The 3-second `AbortController` timeout and 64 KB cap are unchanged. plan.md's ISBN route contract (already documenting 503) was broadened to state that 503 covers all provider-unavailable classes and 404 is reserved for a genuine no-record answer. HTTP-verified: not-found ISBN → 404, unreachable provider → 503, real ISBN → 200, malformed → 400.
- **Routed-to**: `book-seller-architecture-contract` (error-signaling contract for `lookupISBN`).

### DR-4 | 2026-07-02 | dev script does not bind localhost

- **Symptom/drift**: `package.json` dev script is `next dev --turbopack`; plan.md Security says bind `127.0.0.1` (`next dev -H 127.0.0.1`). As shipped, the dev server listens on all interfaces.
- **Status**: FIXED (2026-07-03) — dev script now `next dev --turbopack -H 127.0.0.1`. Narrows exposure, no owner sign-off gate applies (that's only required when widening exposure). DR-1 (CSRF middleware) also now FIXED (Task 23) — both mitigations in place.
- **Routed-to**: was `book-seller-build-and-env`, `book-seller-config-and-constants`.

### DR-5 | 2026-07-02 | Export builds whole CSV in memory

- **Symptom/drift**: plan.md says export "streams CSV via `Response` with readable stream"; `app/api/export/route.ts:52` instead materializes all rows and calls `Papa.unparse` into one string.
- **Status**: ACCEPTED-GAP — sole-seller inventory sizes make the 10-second export budget trivially satisfiable in memory. Revisit only if inventory grows to a scale where export actually slows or bloats.
- **Routed-to**: `book-seller-architecture-contract` if anyone proposes "fixing" it — check it is actually hurting first.

### DR-6 | 2026-07-02 | lib/types.ts is a stub

- **Symptom/drift**: `lib/types.ts` contains only `// stub`. Planned shared type definitions were never written; routes declare their own inline interfaces (e.g. `ValidRow` in the import route).
- **Status**: ACCEPTED-GAP — cosmetic/maintainability, no runtime effect. Worth filling opportunistically when touching multiple routes, not as a standalone campaign.
- **Routed-to**: `book-seller-docs-and-writing` / general cleanup.

### DR-7 | 2026-07-02 | price_history writes 0 instead of NULL for unset previous price

- **Symptom/drift**: When a price is set for the first time, the history row records `previous_price = 0` rather than NULL — the audit trail cannot distinguish "was free/zero" from "was unset". Lossy audit trail vs FR17 ("capturing the previous price").
- **Root cause**: `app/api/books/[id]/route.ts:112-113` — `).run(crypto.randomUUID(), id, oldPrice ?? 0, newPrice ?? 0);` — the `?? 0` coalescing. (Note `new_price ?? 0` has the same problem when clearing a price.)
- **Fix constraint**: the schema declares `previous_price INTEGER NOT NULL` (`data/migrations/001_init.sql`), so "write NULL instead" requires a schema migration (table rebuild — `book-seller-change-control` §4) or a redesigned sentinel; the route-level `?? 0` is a coerced choice, not a free one.
- **Status**: FIXED (Task 26, 2026-07-03). Migration `002_price_history_nullable.sql` rebuilds `price_history` with `previous_price`/`new_price` nullable; `lib/db.ts` gained a `PRAGMA user_version`-guarded runner (migration 002 = version 2) so it applies once and is a no-op on already-migrated DBs. The route now passes `oldPrice, newPrice` (both `number | null`) instead of `?? 0`. Verified at HTTP level: first price set records `previous_price=null`, a genuine 0 records `0` — the two are now distinct. **Existing 0-sentinel rows remain 0 and are NOT backfilled** — still unrecoverable by design; only writes after 2026-07-03 carry the NULL distinction.
- **Routed-to**: was `book-seller-constraint-leak-campaign` if batched with D1/D3 (same file); fixed standalone via `book-seller-change-control` (Task 26).

### D4 | 2026-07-03 | POST /api/books/:id/status Sold response omits gross_profit

- **Symptom**: `AC3: Sale Pending → Sold; gross_profit = sale_price - acquisition_cost` (`tests/integration.test.ts`, HTTP suite) fails with `expected undefined to be 1000` — discovered while temporarily activating the HTTP suite in a scratch copy to verify the D1/D2/D3 regression tests added by `book-seller-constraint-leak-campaign` (2026-07-03). Never caught before because the HTTP suite has always been `describe.skip`.
- **Root cause**: `app/api/books/[id]/status/route.ts` — the row returned after a Sold transition is fetched with `SELECT b.*, COALESCE(GROUP_CONCAT(bp.platform, ','), '') as platforms_csv FROM books b LEFT JOIN book_platforms bp ... WHERE b.id = ?`, which does **not** compute `gross_profit`. Contrast `GET /api/books/:id` and `PATCH /api/books/:id`, both of which add `CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END as gross_profit` to the same query shape. The status route's Sold response is the one place that omits it.
- **Status**: FIXED (Task 20, 2026-07-03) — status route's Sold-response query now includes the same `CASE WHEN b.status = 'Sold' ...` gross_profit clause as GET/PATCH. Spec updated first (plan.md contract + file-map). Verified: HTTP suite activated in a scratch copy, AC3 passes.
- **Routed-to**: was `book-seller-change-control` (behavior-changing); gated and fixed per Task 20 in TASKS.md.

### DR-8 | 2026-07-03 | AC9 HTTP test's CSV header doesn't match the import schema

- **Symptom/drift**: `AC9: POST /api/import 50 rows → imported=48, 2 errors with row and fields` (`tests/integration.test.ts`, HTTP suite) fails with `expected +0 to be 48` — every row is rejected, not just the 2 deliberately-invalid ones. Discovered alongside D4, same activation.
- **Root cause**: the test's CSV header is `title,author,condition,acquisition_cost,acquisition_date` — but `app/api/import/route.ts`'s `REQUIRED_FIELDS` (and the documented import schema, `plan.md` FR21) require `acquisition_cost_usd`. Every row is missing a required field and gets a per-row error; none are imported. This is a bug in the test fixture, not in the import route — the route correctly enforces the documented schema.
- **Status**: FIXED (Task 20, 2026-07-03) — one-line rename of the test's CSV header string to `acquisition_cost_usd`. Verified: HTTP suite activated in a scratch copy, AC9 passes (imported=48, 2 per-row errors).
- **Routed-to**: was `book-seller-validation-and-qa` (test correctness); fixed per Task 20 in TASKS.md.

---

## Rejected-designs register

These were proposed, examined, and **rejected with cause**. Do not re-propose without
new evidence that the original objection no longer applies.

| Rejected design | Incident | Why rejected | Standing decision |
|---|---|---|---|
| Store `gross_profit` as a `books` column | SR-1: pre-review Step 9 divided by 100 before storing, truncating small profits to 0; also a redundant derivation that can drift from its inputs | A stored copy of `sale_price - acquisition_cost` buys nothing and already produced a real bug in its first draft | Compute in SQL at read time, in every SELECT that needs it. **Never store.** |
| Comma-separated `platforms` column on `books` | SR-2 | Unqueryable, no FK integrity, no per-platform metadata; was an unexamined assumption, not a requirement | `book_platforms` junction table is the only representation |

## How to append to this archive

This file is the **single home** for failure history; `book-seller-debugging-playbook`
links here rather than keeping its own list. When you finish an investigation (fixed,
abandoned, or blocked), append an entry:

1. Pick the next ID in the right series: `D` (defect), `T` (trap), `DR` (spec-code drift), `SR` is closed (spec-review era only). New investigations that fit none: `INV`.
2. Add a row to the Chronicle index table **and** a full entry section, in this exact shape:

```markdown
### <ID> | <YYYY-MM-DD> | <one-line symptom>

- **Symptom**: what an operator/session observes, with exact HTTP codes/messages.
- **Root cause**: mechanism, citing file:line (or ASSUMPTION/OPEN if not established).
- **Evidence**: exact commands run, transcripts, diffs — enough for a zero-context session to re-verify without guessing. Mark anything mutating "do not re-run".
- **Status**: OPEN / SUSPECTED / FIXED (with date + what changed) / ACCEPTED-GAP / OWNER-DECISION-PENDING / ENVIRONMENTAL.
- **Routed-to**: sibling skill(s) that own the fix or the caution.
```

3. When an OPEN entry gets fixed, **do not delete it** — flip its status to
   `FIXED (YYYY-MM-DD: <what changed>)` in both the index and the entry. History is the point.
4. Update the "Provenance and maintenance" date at the bottom.
5. Everything here must be ground truth or explicitly labeled ASSUMPTION/OPEN. No
   speculation presented as fact.

Standing evidence-gathering rules (they exist because of T1/T2):

- DB reads only via `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "..."`. Never modify/delete/recreate `data/inventory.db` or its `-wal`/`-shm`.
- Never run `npx vitest run` against the real DB (T1).
- HTTP probes GET-only unless you have explicit approval; confirm the port first (T2); kill any dev server you start.
- Quote bracketed paths in zsh: `cat "app/api/books/[id]/status/route.ts"`.

## When NOT to use this skill

- **Triage of a live, unlisted symptom** — start with `book-seller-debugging-playbook`; come back here to check for priors and to append the outcome.
- **Fixing D1/D2/D3** — the active fix plan lives in `book-seller-constraint-leak-campaign`; this file only records their history.
- **"How do I run/build/test the app?"** — `book-seller-build-and-env`, `book-seller-run-and-operate`.
- **Current architecture or schema questions** ("what IS the design", not "why did it change") — `book-seller-architecture-contract`.
- **Domain semantics** (what Sale Pending means for a bookseller) — `bookselling-domain-reference`.
- **Proposing/authorizing a spec change** — `book-seller-change-control`; `docs/book-inventory-management/` is the change-control authority, not this file.
- **General QA method, tooling, or research** — `book-seller-validation-and-qa`, `book-seller-diagnostics-and-tooling`, `book-seller-research-frontier`, `book-seller-analysis-and-methodology`.
- Writing new failure entries is IN scope; writing anything else (fixes, spec edits) is not — this skill is read-and-append only.

## Provenance and maintenance

Authored 2026-07-02 by a principal-engineer archaeology pass: full read of
`challenge-notes.md`, `requirements.md`(+`.bak` diff), `plan.md`(+`.bak` diff),
`TASKS.md`, `tests/integration.test.ts`, `app/api/import/route.ts`,
`app/api/books/[id]/status/route.ts`, `app/api/books/[id]/route.ts`,
`app/api/export/route.ts`, `app/api/isbn/[isbn]/route.ts`, `lib/db.ts`, `lib/isbn.ts`,
`data/migrations/001_init.sql`, plus the 2026-07-02 live-probe transcripts quoted above.
D1/D2 transcripts are the principal engineer's; do not re-run them.

**Updated 2026-07-03** (constraint-leak-fix session, isolated git worktree): D1 and D2
fixed, D3 confirmed live then fixed, per `book-seller-constraint-leak-campaign`. D4 and
DR-8 newly recorded (discovered incidentally while activating the HTTP suite to verify
the D1/D2/D3 regression tests; out of scope for that campaign, left OPEN). Note the git
history baseline below is now stale — `main` has commits as of 2026-07-03; re-verify
with `git log --oneline | head -1` before trusting "zero commits" claims elsewhere in
this file or in `book-seller-change-control`.

Re-verification one-liners (all read-only; run from repo root):

- No git history: `git -C /Users/prestonbernstein/dev/book-seller log --oneline | head -1` (expect "does not have any commits yet")
- Wipe trap still armed: `grep -n "DELETE FROM price_history" tests/integration.test.ts`
- D1 constraint still present: `grep -n "CHECK (status NOT IN" data/migrations/001_init.sql`
- D2 import still skips normalizeISBN: `grep -n "normalizeISBN" app/api/import/route.ts` (expect no hits)
- DR-1 middleware now present (Task 23): `ls middleware.ts 2>&1`
- DR-2 backup routine now present (Task 24): `grep -n "runStartupBackup" lib/db.ts lib/backup.ts` (expect hits); at runtime a `data/backups/inventory-YYYYMMDD.db` appears after boot
- DR-4 still unbound: `grep -n '"dev"' package.json` (expect no `-H 127.0.0.1`)
- DR-7 fixed (no `?? 0` coalescing left): `grep -n "oldPrice ?? 0" "app/api/books/[id]/route.ts"` (expect no hits); `sqlite3 <db> "SELECT \"notnull\" FROM pragma_table_info('price_history') WHERE name='previous_price'"` (expect 0 = nullable); `grep -n "user_version" lib/db.ts` (migration runner present)
- Spec-review deltas: `diff docs/book-inventory-management/plan.md.bak docs/book-inventory-management/plan.md`
- DB row count (safe): `sqlite3 "file:$PWD/data/inventory.db?mode=ro" "SELECT count(*) FROM books;"`

If any one-liner's expectation fails, the corresponding entry's status is stale —
update it before relying on this archive.
