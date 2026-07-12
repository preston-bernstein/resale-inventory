---
name: resale-inventory-config-and-constants
description: The complete ledger of resale-inventory's (formerly book-seller) configuration surface - every hardcoded constant, limit, enum, and pattern, with exact values, ALL file homes (several are duplicated), and the runbook for changing one safely. Use when asked "where is X defined", "what is the max file size / page size / timeout", "change a limit", "add a status or condition", "is there a feature flag or env var" (two: BOOKSELLER_DB_PATH, BOOKSELLER_PHOTOS_PATH; no feature flags), or before editing any validation bound.
---

# Book-Seller — Config and Constants

**The configuration model of this project: almost none.** Two environment variables are read: `BOOKSELLER_DB_PATH` (`lib/db.ts`, added for the original test-DB-wipe fix) and `BOOKSELLER_PHOTOS_PATH` (`lib/photos.ts`, added when photo upload shipped, same pattern) — see the Runtime/DB table. No `.env*` files exist, no feature flags. Everything else is hardcoded constants — a deliberate simplification for a single-user local app (`plan.md`, Approach) — and the app now covers **two item categories (book, clothing)**, added by the multi-category migration (`docs/multi-category-inventory/`, `data/migrations/003_multi_category.sql`). A prior duplication problem in the condition/status vocabularies has since been **mostly consolidated** into `lib/constants.ts`; what remains duplicated (money cap, ISBN pattern, status-derivation constants) is what this ledger tracks as drift risk.

Jargon: a constant's **homes** are every file where its value is independently written out. Changing a constant means changing every home, or the app disagrees with itself.

## The constants ledger

### Enums and state machine

| Constant | Value | Homes | Notes |
|---|---|---|---|
| Book condition vocabulary | `Poor, Acceptable, Good, Very Good, Like New` | `lib/constants.ts` (`BOOK_CONDITIONS`, single source) + SQL CHECK on `book_details` in `data/migrations/003_multi_category.sql` (live) — a matching CHECK also exists on the archived `books` table in `data/migrations/001_init.sql`, but that table is dead (`books_archived`, not queried by any route) | **Consolidated (2 homes).** Every consumer (`app/api/items/route.ts`, `app/api/items/[id]/route.ts`, `app/api/import/route.ts`, `lib/dashboard.ts`, `components/AddBookForm.tsx`, `components/Dashboard.tsx`, `components/ItemSearch.tsx`) imports `BOOK_CONDITIONS` / calls `conditionsForCategory('book')` rather than redeclaring the list. This used to be a 9-home duplication (`VALID_CONDITIONS` copies) — fixed as part of `lib/constants.ts` consolidation. SQL home still requires the table-rebuild protocol to change |
| Clothing condition vocabulary | `NWT, NWOT, EUC, GUC, Fair` | `lib/constants.ts` (`CLOTHING_CONDITIONS`) + SQL CHECK on `clothing_details` in `data/migrations/003_multi_category.sql` | Same consolidation pattern as book conditions; added by the multi-category migration. Consumers: `app/api/items/route.ts`, `app/api/import/route.ts`, `lib/dashboard.ts`, `components/AddClothingForm.tsx`, `components/Dashboard.tsx` |
| Status vocabulary | `Unlisted, Listed, Sale Pending, Sold, Removed, Donated, Discarded` | `lib/transitions.ts` (`BookStatus` type + `ALLOWED_TRANSITIONS` keys — authoritative), SQL CHECK on `items` in `data/migrations/003_multi_category.sql` (live; matching CHECK on the archived `books` table in `001_init.sql` is dead), `lib/dashboard.ts` (`ALL_STATUSES`) | Transition edges themselves live ONLY in `lib/transitions.ts` (good). `ALL_STATUSES`/`HELD_STATUSES` moved from `app/api/dashboard/route.ts` into `lib/dashboard.ts` when the dashboard logic was extracted; the route is now a thin wrapper calling `getDashboardData()` |
| Held statuses | `Unlisted, Listed, Sale Pending` | `lib/dashboard.ts` (`HELD_STATUSES`) | Definition source: requirements FR15. **Not** in `app/api/dashboard/route.ts` — that file only calls `getDashboardData()` |
| Terminal statuses (PATCH lock) | `Sold, Removed, Donated, Discarded` | `app/api/items/[id]/route.ts` (`TERMINAL`) | Semantically = statuses with empty transition sets in `lib/transitions.ts`; written out separately (drift risk) |

### Money

| Constant | Value | Homes | Notes |
|---|---|---|---|
| Money cap | `100_000_000` cents ($1,000,000) | `lib/money.ts` (usdToCents throw), `app/api/items/route.ts` (acquisition_cost), `app/api/items/[id]/route.ts` (listing_price), `app/api/items/[id]/status/route.ts` (sale_price), `lib/__tests__/money.test.ts` (assertions) | 4 code homes + tests — still the worst live duplication in the repo |
| Money floor | `0` (no negatives) | same four files | |
| Rounding | half-up on 3rd fractional digit | `lib/money.ts` only | See `bookselling-domain-reference` for the why |

### Pagination and input bounds (GET /api/items)

| Constant | Value | Home | Behavior when exceeded |
|---|---|---|---|
| `limit` default | 25 | `app/api/items/route.ts` | — |
| `limit` bounds | 1–200 | `app/api/items/route.ts` | HTTP 400 `{"error":"limit must be 1–200."}` |
| `page` min | 0 (negative rejected, not clamped) | `app/api/items/route.ts` | HTTP 400 `{"error":"page must be a non-negative integer."}` |
| `q` max length | 200 chars | `app/api/items/route.ts` | HTTP 400 `{"error":"q exceeds 200 characters."}` |
| `category` filter | must be one of `CATEGORIES` (`book`, `clothing`) if present | `app/api/items/route.ts` | HTTP 400 `{"error":"Invalid category."}` |
| `condition` filter | validated against the selected category's vocabulary only when `condition` AND `category` are both supplied | `app/api/items/route.ts` | HTTP 422 `{"error":"Validation failed.","fields":["condition"]}` |

### Import / export

| Constant | Value | Home | Notes |
|---|---|---|---|
| MAX_FILE_SIZE | 10 MB (`10 * 1024 * 1024`) | `app/api/import/route.ts` | Checked on Content-Length header AND `file.size`; 413 beyond |
| BOOK_REQUIRED_FIELDS | `title, author, condition, acquisition_cost_usd, acquisition_date` | `app/api/import/route.ts` | Category-specific list — `category` itself is validated first and determines which list applies |
| CLOTHING_REQUIRED_FIELDS | `title, brand, size_label, condition, acquisition_cost_usd, acquisition_date` | `app/api/import/route.ts` | Added by the multi-category migration; measurement fields and `gender_department`/`weight_oz` are optional |
| Ignored sale columns | `sale_price_usd, sale_platform, sale_date, status` | `app/api/import/route.ts` | No longer a named `IGNORED_FIELDS` constant — a code comment documents that these are never read, so every imported row lands as `Unlisted` by construction |
| Export HEADERS (column order) | `id, category, title, isbn, author, publisher, brand, size_label, color, material, gender_department, weight_oz, pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in, condition, acquisition_cost_usd, acquisition_date, status, listing_price_usd, platforms, sale_price_usd, sale_platform, sale_date, gross_profit_usd, created_at, updated_at` | `app/api/export/route.ts` | Fully rewritten for multi-category: book-only cells (isbn/author/publisher) and clothing-only cells (brand..hip_in) are blanked for rows of the other category. Order is a contract; import matches by header NAME, not position |
| Export filename | `inventory-<YYYY-MM-DD>.csv` | `app/api/export/route.ts` | unchanged |
| Formula-injection prefix set | `= + - @` → tab-prefixed | `app/api/export/route.ts` (`sanitize`) | unchanged |

### ISBN and lookup

| Constant | Value | Homes | Notes |
|---|---|---|---|
| ISBN_PATTERN | `/^\d{9}[\dX]$\|^\d{13}$/` | `lib/isbn.ts` AND `app/api/isbn/[isbn]/route.ts` | **2 homes** — pattern only; check digits NOT validated (see `bookselling-domain-reference`). The `isbn` route itself is untouched by the items migration (still at `app/api/isbn/[isbn]/route.ts`) |
| Lookup timeout | 3000 ms (AbortController) | `lib/isbn.ts` | NFR: "complete or time out within 3 seconds" |
| Response cap | 64 KB (MAX_BYTES) | `lib/isbn.ts` | plan.md Security |
| Provider URL | `https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data` | `lib/isbn.ts` | |
| Date shape | `/^\d{4}-\d{2}-\d{2}$/` | `lib/constants.ts` (`DATE_RE`) | **Consolidated to 1 home.** `app/api/items/route.ts`, `app/api/items/[id]/status/route.ts`, and `app/api/import/route.ts` all import `DATE_RE` from `lib/constants.ts` rather than redeclaring it — this used to be a 3-home duplication with one inline literal, now fixed |

### Category and clothing constants (new since the multi-category migration)

| Constant | Value | Home | Notes |
|---|---|---|---|
| CATEGORIES | `book, clothing` | `lib/constants.ts` | Immutable after item creation — enforced by the `items_category_immutable` DB trigger (`data/migrations/003_multi_category.sql`) as well as the PATCH route's field allowlist |
| CLOTHING_MEASUREMENT_FIELDS | `pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in` (8 fields) | `lib/clothing.ts` | Allowlist consumed by create/PATCH/import/export routes; each is optional, non-negative REAL, validated by `validateMeasurement` |
| weight_oz validation | non-negative INTEGER only (rejects e.g. `5.5`) | `lib/clothing.ts` (`validateWeightOz`) + SQL CHECK on `clothing_details` | Matches USPS ounce-tier billing granularity per `docs/reseller-architecture-research.md` |
| gender_department | free text, no fixed vocabulary | `lib/clothing.ts` (`validateGenderDepartment`) | Only type is checked (string or null/absent), not content |

### Photo upload constants (new — clothing items only)

| Constant | Value | Home | Notes |
|---|---|---|---|
| MAX_PHOTO_SIZE | 10 MB | `app/api/items/[id]/photos/route.ts` | Checked against `file.size` and the actual buffer length |
| MAX_PHOTOS_PER_ITEM | 20 | `app/api/items/[id]/photos/route.ts` | HTTP 422 `{"error":"Photo limit exceeded..."}` beyond |
| ALLOWED_CONTENT_TYPES | `image/jpeg, image/png, image/webp` | `app/api/items/[id]/photos/route.ts` | Backed by a magic-byte sniff (`sniffImageType`), not just the declared Content-Type |
| Category gate | photos rejected with 422 unless `item.category === 'clothing'` | `app/api/items/[id]/photos/route.ts` | Deliberate product decision — books never get photo upload (item detail GET always queries `item_photos` but it naturally returns zero rows for book items) |
| Photos root | `process.env.BOOKSELLER_PHOTOS_PATH ?? process.cwd() + '/data/photos'` | `lib/photos.ts` (`PHOTOS_ROOT`) | Second env-var config axis, same pattern as `BOOKSELLER_DB_PATH` |

### Runtime / DB

| Constant | Value | Home | Notes |
|---|---|---|---|
| DB path | `process.env.BOOKSELLER_DB_PATH ?? process.cwd() + '/data/inventory.db'` | `lib/db.ts` | Unset → the cwd-dependent default (unchanged behavior — see `resale-inventory-build-and-env` trap). Set → absolute/relative path to an alternate DB file; used by `vitest.config.ts` / `playwright.config.ts` to point every test run at a scratch file. Server-only, no `NEXT_PUBLIC_` prefix |
| Photos path | `process.env.BOOKSELLER_PHOTOS_PATH ?? process.cwd() + '/data/photos'` | `lib/photos.ts` | Same pattern as DB path; also wired into `vitest.config.ts` / `playwright.config.ts` so photo-upload tests never write into the operator's real `data/photos/` |
| Pragmas | `journal_mode = WAL`, `foreign_keys = ON` | `lib/db.ts` | Non-negotiable (see `resale-inventory-architecture-contract`) |
| Migration runner | versioned array `VERSIONED_MIGRATIONS = [{version:1, file:'001_init.sql'}, {version:2, file:'002_price_history_nullable.sql'}, {version:3, file:'003_multi_category.sql'}]`, gated by `PRAGMA user_version` | `lib/db.ts` | **There IS now a multi-file migration runner** — each migration runs at most once, inside a `db.transaction()`, and bumps `user_version` to its own number. Superseded the old single-hardcoded-file design |
| Backup retention "keep 7" | `RETENTION = 7` | `lib/backup.ts` | **Implemented.** `runStartupBackup()` snapshots via `db.backup()` (WAL-safe) to `data/backups/inventory-YYYYMMDD.db` on every server start and prunes to the newest 7 — this was spec-only in the original plan, now shipped |
| vitest | `environment: 'node'`, alias `@` → repo root, `fileParallelism: false`, coverage thresholds 85/80/85/85 over `app/api/**/*.ts`, `app/**/page.tsx`, `lib/**/*.ts`, `components/**/*.tsx` | `vitest.config.ts` | Same alias in `tsconfig.json` paths. `test.env` also sets `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` to `.vitest-scratch/` paths — this is what makes `vitest run` safe by default now (see Non-negotiable safety facts in `resale-inventory-architecture-contract`) |

## Duplication map, ranked by drift danger

1. **Money cap — 4 code homes + tests.** All must move together or validation disagrees between routes. Now the worst live duplication in the repo.
2. **Status vocabulary + terminal/held derivations — homes spread across `lib/transitions.ts` (authoritative), `lib/dashboard.ts` (`ALL_STATUSES`/`HELD_STATUSES`), `app/api/items/[id]/route.ts` (`TERMINAL`), and the SQL CHECK on `items` in `003_multi_category.sql`.** These are hand-copied derivations that will NOT update themselves.
3. **ISBN_PATTERN — 2 homes** (`lib/isbn.ts`, `app/api/isbn/[isbn]/route.ts`). Unchanged since the migration.
4. **Condition vocabulary — now 2 homes** (`lib/constants.ts` + the live SQL CHECK in `003_multi_category.sql`). This used to be the worst duplication in the repo (9 homes, `VALID_CONDITIONS` copied everywhere); it was consolidated into `lib/constants.ts` and every consumer now imports rather than redeclares. Still requires the table-rebuild protocol to change the SQL side.
5. **Date regex — now 1 home** (`lib/constants.ts`). Previously 3 homes with one inline literal; also consolidated.

`resale-inventory-diagnostics-and-tooling` ships `scripts/constants-drift.sh`, which re-counts these homes and flags changes against the recorded baseline — re-run it after any consolidation like the two above, since the "expected" counts it checks against have moved.

## How to change a constant (runbook)

1. **Classify the change** via `resale-inventory-change-control`. Any constant that alters API behavior (bounds, enums, timeouts) is behavior-changing → spec first (requirements/plan), then code.
2. **Find ALL homes** — do not trust this ledger blindly; re-grep (one-liners in Provenance below).
3. **SQL CHECK involved?** (conditions, statuses, date shapes at DB level) → this is a schema migration: new numbered migration file + table-rebuild pattern, then add `{version: N, file: '<name>.sql'}` to the `VERSIONED_MIGRATIONS` array in `lib/db.ts` (the runner is now a versioned loop gated by `PRAGMA user_version`, not a single hardcoded file). Full protocol: `resale-inventory-change-control` §4.
4. **Update every home in one change**, including UI copies and test assertions (`lib/__tests__/money.test.ts` hardcodes the money cap).
5. **Verify at HTTP level** per `resale-inventory-validation-and-qa` — unit tests alone missed both live defects.
6. Run `scripts/constants-drift.sh` afterwards and update its baseline numbers + this ledger + the Provenance date.

## How to add a real config axis (guidance, not current practice)

If something genuinely must vary per environment:
- Read it via `process.env.BOOKSELLER_*` with the current hardcoded value as default, so existing behavior is unchanged when unset.
- Server-only values need no `NEXT_PUBLIC_` prefix; never put secrets in `NEXT_PUBLIC_*`.
- This is behavior-adjacent → gate through `resale-inventory-change-control`, document the axis HERE (this ledger is the single home for config facts), and add it to the drift script.

**Worked examples:** `BOOKSELLER_DB_PATH` in `lib/db.ts` — the configurable DB path that fixes the original test-DB-wipe trap. `BOOKSELLER_PHOTOS_PATH` in `lib/photos.ts` followed the identical pattern when photo upload shipped. Both follow the pattern above exactly: `process.env.BOOKSELLER_*_PATH ?? <cwd default>`, so an unset var reproduces the original hardcoded behavior byte-for-byte. `BOOKSELLER_PHOTOS_PATH` is the more recent reference to copy for the next axis.

## When NOT to use this skill

- WHY a value/design is what it is → `bookselling-domain-reference` (domain meaning) or `resale-inventory-architecture-contract` (design rationale).
- Whether you are ALLOWED to change it and what the gate is → `resale-inventory-change-control`.
- The change procedure for schema/CHECK constraints in depth → `resale-inventory-change-control` §4.
- Automated drift detection → `resale-inventory-diagnostics-and-tooling`.

## Provenance and maintenance

Authored 2026-07-02. Content-audited and substantially rewritten to match the post-multi-category-migration codebase (multi-category books+clothing, `app/api/items/*` routes, versioned migration runner, `lib/constants.ts` consolidation, second `BOOKSELLER_PHOTOS_PATH` env axis, photo-upload limits). All values and homes re-verified against the current repo by reading the cited files and grep sweeps. Values drift; homes drift harder. Re-verification one-liners (run from repo root):

- Condition homes: `grep -rln "Like New" app lib components data/migrations` (expect ~5 hits: `lib/constants.ts` source, 2 test fixtures, and 2 migration SQL files — `001_init.sql`'s CHECK is on the dead `books_archived` table, `003_multi_category.sql`'s is the live one)
- Status edges: `grep -n "ALLOWED_TRANSITIONS" lib/transitions.ts`
- Money cap homes: `grep -rln "100_000_000" app lib` (expect `app/api/items/route.ts`, `app/api/items/[id]/route.ts`, `app/api/items/[id]/status/route.ts`, `lib/money.ts`, and `lib/__tests__/money.test.ts` since the test file lives under `lib/`)
- Date-regex homes: `grep -rln 'DATE_RE' app lib` (expect exactly `lib/constants.ts` as the definition, plus every route that imports it — no inline literal should remain)
- ISBN_PATTERN homes: `grep -rln "ISBN_PATTERN" app lib` (expect `lib/isbn.ts` and `app/api/isbn/[isbn]/route.ts`)
- Import limits/fields: `grep -n "MAX_FILE_SIZE\|REQUIRED_FIELDS" app/api/import/route.ts`
- Export headers: `grep -n "const HEADERS" app/api/export/route.ts`
- Pagination/q bounds: `grep -n "limit\|200" app/api/items/route.ts | head`
- Env-var surface: `grep -rn "process.env.BOOKSELLER" app lib` (expect exactly two axes — `BOOKSELLER_DB_PATH` in `lib/db.ts`, `BOOKSELLER_PHOTOS_PATH` in `lib/photos.ts`; any additional hit is a new config axis — document it here)
- Migration wiring: `grep -n "VERSIONED_MIGRATIONS\|pragma" lib/db.ts`
