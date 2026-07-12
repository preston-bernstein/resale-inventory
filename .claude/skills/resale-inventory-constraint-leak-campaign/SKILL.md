---
name: resale-inventory-constraint-leak-campaign
description: COMPLETED (2026-07-03) - historical record and reusable methodology for resale-inventory's (formerly book-seller) constraint-leak 500 cluster (D1 - transition to Listed without listing_price gave opaque HTTP 500; D2 - import with duplicate ISBN gave 500 and lost the whole batch; D3 - PATCH listing_price null gave 500; D4 - Sold response omitted gross_profit). All four are FIXED and locked in by regression tests. Load when asked to "fix the import bug", "fix the 500 on status change", investigate "SqliteError" or "CHECK constraint" failures, make import errors per-row, or diagnose a NEW constraint-leak-shaped defect (this file is the template for that investigation, not a currently-open task list). For current status of D1-D4, see resale-inventory-failure-archaeology.
---

# Book-Seller — Constraint-Leak Campaign

> **STATUS: CAMPAIGN COMPLETE (2026-07-03).** D1, D2, D3, and D4 are all FIXED — see `resale-inventory-failure-archaeology` for the authoritative current status and fix transcripts. **This file is a historical record of a completed campaign, kept as a reusable methodology template** for diagnosing a *similar* constraint-leak-shaped defect in the future. Everything below — including all `curl` commands, file paths, and table names — reflects the schema and routes **as they existed on 2026-07-02/03**, i.e. the original single-category `books`/`book_platforms` schema and `app/api/books/**` routes. That schema and route surface no longer exist: migration `003_multi_category.sql` (2026-07-11) rebuilt them into `items`+`book_details`+`clothing_details` and `app/api/items/**`, archiving `books`→`books_archived` and `book_platforms`→`book_platforms_archived`. **Do not run the commands below verbatim against the current app** — they target routes and tables that are gone. If you're investigating a *new* constraint-leak defect on the current schema, use this file's phase structure (reproduce → root-cause → solution menu → validate) as the template, but substitute `items`/`book_details`/`clothing_details`/`item_platforms` for `books`/`book_platforms` and `app/api/items/**` for `app/api/books/**` throughout.

**Target (historical):** DB CHECK constraints and the ISBN unique index fired inside API routes whose catch-alls converted everything to an opaque HTTP 500 (status route body: `{"error":"Internal server error."}`; import route body: `{"error":"Internal server error"}` — no trailing period) — instead of the spec-mandated 4xx with a plain-English message (`plan.md` API contract: 422 validation / 409 duplicate; `requirements.md` FR22/AC9: per-row import errors "without aborting the entire batch").

> ASSUMPTION (coordinator-approved, 2026-07-02): this cluster was, at the time, the project's hardest live problem and the highest-priority fix. It has since been fixed; treat this ASSUMPTION as historical framing, not a current priority claim.

**Success was measured, never judged by eye** — the campaign ended when every numbered criterion in Phase 5 went green, which it did (2026-07-03).

## Two rulebooks — know which applies to you

- **Authoring-time rules** governed the writing of this skill (2026-07-02): no mutating requests were run; the transcripts below come from the principal engineer's original live verification earlier that day.
- **Execution-time protocol** (this document) governs you, the fixing session: you MAY edit code and run mutating probes, **only** inside the tagging/cleanup protocol below, **only** after Phase 0 passes.

**Execution-time laws:** every probe row you create is titled `CAMPAIGN-PROBE-<YYYY-MM-DD>...` so cleanup is exact. Never delete/recreate `data/inventory.db` itself. Never run `npx vitest run` from the repo root (wipes the DB — `resale-inventory-validation-and-qa`). The one sanctioned direct-DB write in this campaign is deleting rows the campaign itself created (there is no DELETE API route — verified: `app/api/books/[id]/route.ts` exports only GET and PATCH).

## Phase 0 — Preconditions (gate)

```bash
cd /Users/prestonbernstein/dev/book-seller
```

| # | Check | Command | EXPECT | If not |
|---|---|---|---|---|
| 0.1 | Build green | `npm run build` | Route table with 13 routes, no errors | STOP — fix build first (`resale-inventory-build-and-env`) |
| 0.2 | Operator backup taken | `sqlite3 data/inventory.db ".backup 'data/backups/inventory-$(date +%Y%m%d)-pre-campaign.db'"` then `sqlite3 "data/backups/..." "PRAGMA integrity_check;"` → `ok` | Backup exists, integrity ok | STOP — no mutation without backup (`resale-inventory-run-and-operate`) |
| 0.3 | Server up, real port known | `npm run dev` (or `-H 127.0.0.1 -p 3005`), then `.claude/skills/resale-inventory-diagnostics-and-tooling/scripts/find-port.sh` | Prints a port; set `B=http://127.0.0.1:<port>` | Port trap — never probe :3000 blind |
| 0.4 | Baseline tests green | Scratch-copy procedure B in `resale-inventory-validation-and-qa` | `139 passed | 15 skipped` (+N for tests added since 2026-07-02) | STOP — investigate first |
| 0.5 | DB invariants clean | `.claude/skills/resale-inventory-diagnostics-and-tooling/scripts/db-integrity.sh` | `DB-INTEGRITY: clean` | STOP — record in failure-archaeology |

## Phase 1 — Reproduce Defect D1 (gate)

```bash
# 1a. Create a probe book (no listing_price on purpose)
curl -s -X POST $B/api/books -H 'Content-Type: application/json' -d '{
  "title":"CAMPAIGN-PROBE-'$(date +%F)'-D1","author":"Campaign","condition":"Good",
  "acquisition_cost":500,"acquisition_date":"2026-07-01"}'
# EXPECT: HTTP 201, JSON with "id" — capture it as $ID and "status":"Unlisted"

# 1b. Transition to Listed with NO listing_price set
curl -s -w "\nHTTP %{http_code}\n" -X POST $B/api/books/$ID/status \
  -H 'Content-Type: application/json' -d '{"status":"Listed"}'
```

**EXPECT (defect live — original transcript 2026-07-02):**

```
{"error":"Internal server error."}
HTTP 500
```

| Observation | Branch |
|---|---|
| 500 as above | Defect confirmed → Phase 2 |
| `HTTP 422` with a message about listing_price | Already fixed → verify D2, then jump to Phase 5 (regression-lock what exists) |
| `HTTP 200` (transition succeeded) | The DB CHECK was weakened — **worse than the defect.** STOP; check `sqlite3 "file:data/inventory.db?mode=ro" ".schema books"` for the CHECK clauses; record in failure-archaeology; escalate via change-control |
| Anything else | Record verbatim in failure-archaeology; re-check you hit the right port |

## Phase 2 — Reproduce Defect D2 (gate)

Fixture ships with this skill: `fixtures/dup-isbn.csv` (rows 1+2 share ISBN 9780306406157; row 3 valid, no ISBN).

```bash
# Pre-check: is 9780306406157 already in the DB? (affects expected counts)
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COUNT(*) FROM books WHERE isbn='9780306406157';"

curl -s -w "\nHTTP %{http_code}\n" -X POST $B/api/import \
  -F "file=@.claude/skills/resale-inventory-constraint-leak-campaign/fixtures/dup-isbn.csv"
curl -s "$B/api/books?title=CAMPAIGN-PROBE" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["total"])'
```

**EXPECT (defect live — original transcript 2026-07-02):** `{"error":"Internal server error"}` / `HTTP 500`, and the follow-up count shows **0 of the 3 fixture rows landed** (the valid row C was lost with the batch).

| Observation | Branch |
|---|---|
| 500 + 0 imported | Confirmed → Phase 3 |
| `{"imported":2,"errors":[...]}`-shaped 200 (one dup rejected per-row, valid rows kept) | Already fixed → Phase 5 |
| 500 but some rows landed | Transaction atomicity broke differently than documented — record exact counts in failure-archaeology before proceeding |

## Phase 3 — Root-cause confirmation (read, then verify D3)

Confirm each mechanism claim against current code — do not skip; the fix targets these exact lines:

| File | Confirm |
|---|---|
| `data/migrations/001_init.sql` | `CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL)` and `CREATE UNIQUE INDEX ... idx_books_isbn` |
| `app/api/books/[id]/status/route.ts` | Route validates sale_* fields for Sold but **never checks listing_price for Listed/Sale Pending**; outer `catch` → 500 |
| `app/api/import/route.ts` | No `normalizeISBN` call (raw strip only), no in-file or vs-DB duplicate check, single `insertAll` transaction → one throw kills the batch |
| `app/api/books/route.ts` | The CONTRAST: POST normalizes ISBN and returns `409 {"error":"ISBN already exists."}` on duplicates — import lacks exactly this |
| `app/api/books/[id]/route.ts` | PATCH allows `listing_price: null` ("allow clearing to null") with no status check against the CHECK → D3 hypothesis |

**Verify D3 now** (prediction first — `resale-inventory-analysis-and-methodology`): predict `HTTP 500` when PATCHing `{"listing_price": null}` on a Listed book. Create a second probe book, PATCH it a price, transition it to Listed, then:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X PATCH $B/api/books/$ID2 \
  -H 'Content-Type: application/json' -d '{"listing_price": null}'
```

Record the result in failure-archaeology (D3: SUSPECTED → CONFIRMED or REFUTED, with transcript). If confirmed, D3 joins the fix scope.

## Phase 4 — Solution menu (ranked; changes are spec-gated)

**Before writing code:** classify via `resale-inventory-change-control` (behavior-changing — API status codes change from 500 to 4xx) and update `plan.md`'s API contract (and requirements if AC wording moves) FIRST.

### A — Pre-validation in routes (recommended core)

- **Status route:** when target status is `Listed` or `Sale Pending`, check the book's `listing_price IS NOT NULL` (after applying any request-supplied value, if the design adds one) → else `422 {"error":"Cannot list a book without a listing_price. Set a price first via PATCH."}` (plain-English per house style). Sold-path validation already exists — leave it.
- **Import route:** per row — run `normalizeISBN` (invalid → per-row error entry); collect an in-file `Set` of seen ISBNs (dup-in-file → per-row error); one prepared `SELECT id FROM books WHERE isbn = ?` per candidate (dup-vs-DB → per-row error). Valid rows still commit **in a single transaction** — this preserves FR22's exact wording ("all valid rows are committed in a single transaction" — plan.md import contract) while errors become per-row. Quote FR22 in the spec delta.
- **PATCH route (if D3 confirmed):** clearing `listing_price` to null on a Listed/Sale Pending book → `422` explaining the invariant (or auto-delist semantics — that is a REQUIREMENTS question; do not invent it, raise via change-control).
- **Theory obligations:** every DB rule that a route can trigger gets a route-level guard producing a 4xx — run the constraint-coverage audit (`resale-inventory-analysis-and-methodology`) after coding to prove no rule is left uncovered.

### B — SqliteError mapping at route boundaries (defense-in-depth)

Catch `better-sqlite3` errors and map by the error's `.code` property (never string-match messages): `SQLITE_CONSTRAINT_CHECK` → 422 generic-but-honest body; `SQLITE_CONSTRAINT_UNIQUE` → 409. **Obligation:** B alone does NOT fix D2's batch loss (the transaction still aborts) — B is the net under A, not a substitute.

**Recommended: A + B.**

### Fenced-off wrong paths (do not take; each violates a standing decision)

| Wrong path | Why fenced |
|---|---|
| Weaken/drop the CHECK constraints | The DB is the last line of integrity; non-negotiable (`resale-inventory-change-control` §3, `resale-inventory-architecture-contract`) |
| Store gross_profit to "simplify" anything | REJECTED design with a real incident behind it (SR-1, failure-archaeology) |
| Add Listed→Sold or auto-set a default listing_price to dodge the CHECK | State-machine and pricing semantics are spec-owned (FR10; AC3 dispute SR-6 is owner-pending — do not settle it by side effect) |
| Per-row transactions in import | Violates FR22's single-transaction wording without a spec amendment |
| Catch-and-ignore (swallow the throw, return 200) | Silent data loss; worse than the 500 |
| Hand-edit the DB beyond campaign-probe cleanup | Sacred-DB rules |

## Phase 5 — Validation and promotion (gates; ALL must pass)

1. **D1 regression probe:** Phase 1 sequence → `HTTP 422` with the documented message; then set a price via PATCH, retry → `HTTP 200`, status Listed.
2. **D2 regression probe:** Phase 2 fixture → `HTTP 200 {"imported": I, "errors":[E1..]}` where (fresh DB state, ISBN not pre-existing): `imported = 2` (first occurrence of the ISBN + row C) and 1 dup-in-file error naming row 3 of the file (CSV row numbering: header = row 1) — or `imported = 1` + 2 errors if the ISBN pre-exists in the DB. State your expected numbers BEFORE running, per the pre-check in Phase 2.
3. **D3:** per its Phase 3 verdict — regression probe with expected 4xx, or documented REFUTED.
4. **New HTTP regression tests added** following `resale-inventory-validation-and-qa` §how-to-add (configurable base URL, defect IDs in test names).
5. **Scratch-copy suite:** `139+N passed | 15 skipped` (N = your new tests; adjust if the HTTP suite base becomes runnable).
6. **`db-integrity.sh` → clean** and **`api-smoke.sh` → all PASS**.
7. **Probe cleanup executed and verified:**
```bash
sqlite3 data/inventory.db "DELETE FROM books WHERE title LIKE 'CAMPAIGN-PROBE%';"
sqlite3 "file:data/inventory.db?mode=ro" "SELECT COUNT(*) FROM books WHERE title LIKE 'CAMPAIGN-PROBE%';"  # EXPECT 0
```
(Also remove any price_history/book_platforms rows for those ids — FK query in db-integrity.sh will catch strays.)
8. **Spec updated:** plan.md API contract shows the new 4xx behaviors; requirements delta if any AC wording moved; TASKS/record per change-control.
9. **failure-archaeology updated:** D1/D2 (and D3) flipped to FIXED with the regression transcripts as evidence.
10. **Kill the dev server**; final `find-port.sh` confirms nothing stray is listening.

Only after 1–10: report the campaign complete, citing each criterion's evidence.

## When NOT to use this skill

- You just saw a 500 and don't know it's this cluster yet → `resale-inventory-debugging-playbook` (triage first).
- General "how do I make changes here" → `resale-inventory-change-control`.
- Running tests safely → `resale-inventory-validation-and-qa`.
- The AC3 Listed→Sold dispute → not yours to settle; it is OWNER-DECISION-PENDING (SR-6).

## Provenance and maintenance

Authored 2026-07-02. Defect transcripts from live verification that day (D1: probe book 201 → status POST 500 exact body; D2: 3-row fixture → 500, 0 imported, verified by follow-up GET). Mechanism claims verified against `data/migrations/001_init.sql`, both books routes, the status route, and the import route as of that date. Fixture `fixtures/dup-isbn.csv` matches the original reproduction. No DELETE API route existed (GET/PATCH only in `app/api/books/[id]/route.ts`, which itself no longer exists post-migration).

**Content-refreshed 2026-07-12:** confirmed via `git log` and `resale-inventory-failure-archaeology` that D1/D2/D3 were fixed 2026-07-03 (commits `94224e2`, `048f781` and surrounding), D4 fixed the same day (Task 20), and all four are locked in by regression tests in `tests/integration.test.ts`. Confirmed via current source that `app/api/items/[id]/status/route.ts` now pre-validates `listing_price` before allowing →Listed/Sale Pending (422), `app/api/import/route.ts` now calls `normalizeISBN` and reports per-row errors, and the PATCH route on `app/api/items/[id]/route.ts` rejects clearing `listing_price` to null while Listed/Sale Pending. This file's `curl`/`sqlite3`/`grep` commands were NOT updated to the current `items` schema — they are preserved as the historical record of what was actually run; do not execute them verbatim expecting them to hit live routes.

If picking this file up as a template for a NEW constraint-leak investigation, re-verify against current state instead of the checks below (which describe 2026-07-02 status):
- Current route surface: `find app/api/items -name "route.ts"` (the status/PATCH/import logic now lives here, not under `app/api/books`).
- Current schema: `sqlite3 "file:data/inventory.db?mode=ro" ".schema items" ".schema book_details" ".schema clothing_details"` for the live CHECK clauses.
- Whether a NEW defect's mechanism resembles D1-D4: `grep -n "normalizeISBN" app/api/import/route.ts` (expect hits — this is now the fixed state, the opposite of the original "expect no hits while defect lives" check).
- D1-D4 current status: `resale-inventory-failure-archaeology` (expect all four FIXED; if any shows a different status, something regressed).
- **`fixtures/dup-isbn.csv` is now structurally stale, not just route-stale:** the current `app/api/import/route.ts` requires a `category` column (`BOOK_REQUIRED_FIELDS`/`CLOTHING_REQUIRED_FIELDS` both include it; see the file's `import { CATEGORIES } from '@/lib/constants'` validation), which this fixture predates and does not have. Reusing it against the current import route would fail on a missing-`category` error, not reproduce a duplicate-ISBN scenario. A new fixture with a `category,book` column would be needed for any current-schema reproduction.
