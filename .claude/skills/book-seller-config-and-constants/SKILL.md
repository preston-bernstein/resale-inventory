---
name: book-seller-config-and-constants
description: The complete ledger of book-seller's configuration surface - every hardcoded constant, limit, enum, and pattern, with exact values, ALL file homes (several are duplicated), and the runbook for changing one safely. Use when asked "where is X defined", "what is the max file size / page size / timeout", "change a limit", "add a status or condition", "is there a feature flag or env var" (one: BOOKSELLER_DB_PATH; no feature flags), or before editing any validation bound.
---

# Book-Seller — Config and Constants

**The configuration model of this project: almost none.** Exactly one environment variable is read (`BOOKSELLER_DB_PATH`, in `lib/db.ts`, added 2026-07-03 for the T1 test-wipe fix — see the Runtime/DB table); no `.env*` files exist, no feature flags. Everything else is hardcoded constants — a deliberate simplification for a single-user local app (`plan.md`, Approach) — and several of them are **duplicated across files**, which is the drift risk this ledger exists to manage.

Jargon: a constant's **homes** are every file where its value is independently written out. Changing a constant means changing every home, or the app disagrees with itself.

## The constants ledger

### Enums and state machine

| Constant | Value | Homes | Notes |
|---|---|---|---|
| Condition vocabulary | `Poor, Acceptable, Good, Very Good, Like New` | `app/api/books/route.ts` (VALID_CONDITIONS), `app/api/books/[id]/route.ts` (VALID_CONDITIONS), `app/api/import/route.ts` (VALID_CONDITIONS Set), `app/api/dashboard/route.ts` (ALL_CONDITIONS), `data/migrations/001_init.sql` (CHECK), + UI copies in `components/AddBookForm.tsx`, `components/BookSearch.tsx`, `components/Dashboard.tsx`, `app/books/[id]/page.tsx` | **9 homes — worst duplication in the repo.** SQL home requires table rebuild to change |
| Status vocabulary | `Unlisted, Listed, Sale Pending, Sold, Removed, Donated, Discarded` | `lib/transitions.ts` (BookStatus type + ALLOWED_TRANSITIONS keys — authoritative), `data/migrations/001_init.sql` (CHECK), `app/api/dashboard/route.ts` (ALL_STATUSES), plus UI components | Transition edges themselves live ONLY in `lib/transitions.ts` (good) |
| Held statuses | `Unlisted, Listed, Sale Pending` | `app/api/dashboard/route.ts` (HELD_STATUSES) | Definition source: requirements FR15 |
| Terminal statuses (PATCH lock) | `Sold, Removed, Donated, Discarded` | `app/api/books/[id]/route.ts` (TERMINAL) | Semantically = statuses with empty transition sets in `lib/transitions.ts`; written out separately (drift risk) |

### Money

| Constant | Value | Homes | Notes |
|---|---|---|---|
| Money cap | `100_000_000` cents ($1,000,000) | `lib/money.ts` (usdToCents throw), `app/api/books/route.ts` (acquisition_cost), `app/api/books/[id]/route.ts` (listing_price), `app/api/books/[id]/status/route.ts` (sale_price), `lib/__tests__/money.test.ts` (assertions) | 4 code homes + tests |
| Money floor | `0` (no negatives) | same four files | |
| Rounding | half-up on 3rd fractional digit | `lib/money.ts` only | See `bookselling-domain-reference` for the why |

### Pagination and input bounds (GET /api/books)

| Constant | Value | Home | Behavior when exceeded |
|---|---|---|---|
| `limit` default | 25 | `app/api/books/route.ts` | — |
| `limit` bounds | 1–200 | `app/api/books/route.ts` | HTTP 400 `{"error":"limit must be 1–200."}` |
| `page` min | 0 (negative clamped to 0) | `app/api/books/route.ts` | clamped, not rejected |
| `q` max length | 200 chars | `app/api/books/route.ts` | HTTP 400 `{"error":"q exceeds 200 characters."}` |

### Import / export

| Constant | Value | Home | Notes |
|---|---|---|---|
| MAX_FILE_SIZE | 10 MB (`10 * 1024 * 1024`) | `app/api/import/route.ts` | Checked on Content-Length header AND `file.size`; 413 beyond |
| REQUIRED_FIELDS | `title, author, condition, acquisition_cost_usd, acquisition_date` | `app/api/import/route.ts` | = requirements FR21 |
| IGNORED_FIELDS | `sale_price_usd, sale_platform, sale_date, status` | `app/api/import/route.ts` | Declared but note: the loop ignores ALL non-required, non-optional columns anyway |
| Export HEADERS (column order) | `id, isbn, title, author, publisher, condition, acquisition_cost_usd, acquisition_date, status, listing_price_usd, platforms, sale_price_usd, sale_platform, sale_date, gross_profit_usd, created_at, updated_at` | `app/api/export/route.ts` | Order is a contract (plan.md API section); import matches by header NAME, not position |
| Export filename | `inventory-<YYYY-MM-DD>.csv` | `app/api/export/route.ts` | |
| Formula-injection prefix set | `= + - @` → tab-prefixed | `app/api/export/route.ts` (sanitize) | |

### ISBN and lookup

| Constant | Value | Homes | Notes |
|---|---|---|---|
| ISBN_PATTERN | `/^\d{9}[\dX]$|^\d{13}$/` | `lib/isbn.ts` AND `app/api/isbn/[isbn]/route.ts` | **2 homes** — pattern only; check digits NOT validated (see `bookselling-domain-reference`) |
| Lookup timeout | 3000 ms (AbortController) | `lib/isbn.ts` | NFR: "complete or time out within 3 seconds" |
| Response cap | 64 KB (MAX_BYTES) | `lib/isbn.ts` | plan.md Security |
| Provider URL | `https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data` | `lib/isbn.ts` | |
| Date shape | `/^\d{4}-\d{2}-\d{2}$/` | `app/api/books/route.ts` (DATE_RE), `app/api/books/[id]/status/route.ts` (DATE_RE), `app/api/import/route.ts` (inline literal) | **3 homes**, one unnamed — easy to miss in a sweep |

### Runtime / DB

| Constant | Value | Home | Notes |
|---|---|---|---|
| DB path | `process.env.BOOKSELLER_DB_PATH ?? process.cwd() + '/data/inventory.db'` | `lib/db.ts` | **The one env-var config axis.** Unset → the cwd-dependent default (unchanged behavior — see `book-seller-build-and-env` trap). Set → absolute/relative path to an alternate DB file; used by the safe-test procedure to escape the T1 wipe trap (`book-seller-validation-and-qa`). Added 2026-07-03. Server-only, no `NEXT_PUBLIC_` prefix |
| Pragmas | `journal_mode = WAL`, `foreign_keys = ON` | `lib/db.ts` | Non-negotiable (see `book-seller-architecture-contract`) |
| Migration file | `data/migrations/001_init.sql` | `lib/db.ts` (hardcoded single file) | There is NO multi-file migration runner |
| Backup retention "keep 7" | — | `docs/book-inventory-management/plan.md` Risk 6 ONLY | **SPEC-ONLY — never implemented** (DR-2 in failure-archaeology) |
| vitest | `environment: 'node'`, alias `@` → repo root | `vitest.config.ts` | Same alias in `tsconfig.json` paths |

## Duplication map, ranked by drift danger

1. **Condition vocabulary — 9 homes** including a SQL CHECK. Changing it means: 4 API/lib homes + 4 UI homes + a table-rebuild migration (see change gate below). Highest-risk change in the repo.
2. **Status vocabulary + terminal/held derivations — 4+ homes.** `lib/transitions.ts` is authoritative; `TERMINAL` in the PATCH route and `HELD_STATUSES`/`ALL_STATUSES` in dashboard are hand-copied derivations that will NOT update themselves.
3. **Money cap — 4 code homes + tests.** All must move together or validation disagrees between routes.
4. **Date regex — 3 homes, one inline** (import route). The inline one is the one sweeps miss.
5. **ISBN_PATTERN — 2 homes.**

`book-seller-diagnostics-and-tooling` ships `scripts/constants-drift.sh`, which re-counts these homes and flags changes against the recorded baseline.

## How to change a constant (runbook)

1. **Classify the change** via `book-seller-change-control`. Any constant that alters API behavior (bounds, enums, timeouts) is behavior-changing → spec first (requirements/plan), then code.
2. **Find ALL homes** — do not trust this ledger blindly; re-grep (one-liners in Provenance below).
3. **SQL CHECK involved?** (conditions, statuses, date shapes at DB level) → this is a schema migration: new numbered migration + table-rebuild pattern + extending `lib/db.ts` to run it (no multi-file runner exists). Full protocol: `book-seller-change-control` §4.
4. **Update every home in one change**, including UI copies and test assertions (`lib/__tests__/money.test.ts` hardcodes the money cap).
5. **Verify at HTTP level** per `book-seller-validation-and-qa` — unit tests alone missed both live defects.
6. Run `scripts/constants-drift.sh` afterwards and update its baseline numbers + this ledger + the Provenance date.

## How to add a real config axis (guidance, not current practice)

If something genuinely must vary per environment:
- Read it via `process.env.BOOKSELLER_*` with the current hardcoded value as default, so existing behavior is unchanged when unset.
- Server-only values need no `NEXT_PUBLIC_` prefix; never put secrets in `NEXT_PUBLIC_*`.
- This is behavior-adjacent → gate through `book-seller-change-control`, document the axis HERE (this ledger is the single home for config facts), and add it to the drift script.

**Worked example (implemented 2026-07-03):** `BOOKSELLER_DB_PATH` in `lib/db.ts` — the configurable DB path that fixes the T1 test-wipe trap (`book-seller-validation-and-qa`). Follows the pattern above exactly: `process.env.BOOKSELLER_DB_PATH ?? <cwd default>`, so an unset var reproduces the original hardcoded behavior byte-for-byte. This is the reference to copy for the next axis.

## When NOT to use this skill

- WHY a value/design is what it is → `bookselling-domain-reference` (domain meaning) or `book-seller-architecture-contract` (design rationale).
- Whether you are ALLOWED to change it and what the gate is → `book-seller-change-control`.
- The change procedure for schema/CHECK constraints in depth → `book-seller-change-control` §4.
- Automated drift detection → `book-seller-diagnostics-and-tooling`.

## Provenance and maintenance

Authored 2026-07-02. Updated 2026-07-03: added the `BOOKSELLER_DB_PATH` config axis (T1 test-wipe fix) — the project's first env var. All values and homes verified by reading the cited files and grep sweeps. Values drift; homes drift harder. Re-verification one-liners (run from repo root):

- Condition homes: `grep -rln "Like New" app lib components data/migrations`
- Status edges: `grep -n "ALLOWED_TRANSITIONS" lib/transitions.ts`
- Money cap homes: `grep -rln "100_000_000" app lib`
- Date-regex homes: `grep -rln 'd{4}-' app lib` (expect 3 files: books route, status route, import route — the substring hits both the named `DATE_RE` constants and the import route's inline literal)
- ISBN_PATTERN homes: `grep -rln "ISBN_PATTERN" app lib`
- Import limits/fields: `grep -n "MAX_FILE_SIZE\|REQUIRED_FIELDS\|IGNORED_FIELDS" app/api/import/route.ts`
- Export headers: `grep -n "const HEADERS" app/api/export/route.ts`
- Pagination/q bounds: `grep -n "limit\|200" app/api/books/route.ts | head`
- Env-var surface: `grep -rn "process.env" app lib` (2026-07-03: exactly one hit — `BOOKSELLER_DB_PATH` in `lib/db.ts`; any additional hit is a new config axis — document it here)
- Pragmas + migration wiring: `grep -n "pragma\|001_init" lib/db.ts`
