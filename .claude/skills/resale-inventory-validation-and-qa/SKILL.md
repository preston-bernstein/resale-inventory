---
name: resale-inventory-validation-and-qa
description: How to run resale-inventory's tests (Vitest unit/component/API, Playwright E2E, Stryker mutation, fallow static analysis) WITHOUT destroying real data, what counts as evidence here, coverage/mutation thresholds, and how to add tests. Load BEFORE running any test command in this repo - "run tests", "vitest", "playwright", "stryker", "is it safe to run tests", "add a test", "verify a change", "acceptance criteria", "QA", "why did tests pass but the API is broken". The full QA stack is bigger than it looks from the package.json script names alone — this skill is the map.
---

# Resale Inventory — Validation and QA

## The DB-wipe trap — HISTORICAL, now fixed by config (verify before trusting)

**Originally:** `npx vitest run` from the repo root deleted all inventory data, because `tests/integration.test.ts`'s `beforeEach` truncated the live tables and `lib/db.ts` had no way to point at anything other than `process.cwd() + '/data/inventory.db'`. This was tracked as **T1** (see `resale-inventory-failure-archaeology`).

**Now:** `lib/db.ts` resolves its DB path from `process.env.BOOKSELLER_DB_PATH`, falling back to the real `data/inventory.db` only when that variable is unset. `vitest.config.ts` sets it (and `BOOKSELLER_PHOTOS_PATH`) inside `test.env` to scratch files under `<repo>/.vitest-scratch/` — so every Vitest run, including a plain `npx vitest run` or `npm test` from the repo root, is redirected to a throwaway DB **automatically**, with no operator discipline required. `playwright.config.ts` does the identical thing under `<repo>/.playwright-scratch/` for the E2E `webServer`. T1 is fixed.

The wipe mechanism itself is unchanged and still worth knowing, because it is what makes the scratch-file redirection load-bearing:

```ts
// tests/integration.test.ts, beforeEach, ~line 138-140
db.exec(
  'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
  'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;'
);
```

(Table names updated for the multi-category schema — the original wipe targeted `books`/`book_platforms`/`price_history`; the live tables are now `items`/`book_details`/`clothing_details`/`item_platforms`/`item_photos`/`price_history`.)

**Do not take "it's fixed" on faith — this is exactly the kind of thing that silently regresses.** Before running any test command against a repo you haven't touched recently, confirm the safety net is actually wired:

```bash
grep -n "BOOKSELLER_DB_PATH" vitest.config.ts playwright.config.ts lib/db.ts lib/photos.ts
# Expect: vitest.config.ts sets it inside test.env; playwright.config.ts sets it inside webServer.env;
# lib/db.ts and lib/photos.ts both read it via process.env.BOOKSELLER_DB_PATH / BOOKSELLER_PHOTOS_PATH.
```

If any of those greps come back empty, treat the DB as unprotected and fall back to the old discipline: never run the suite from the repo root; copy the repo to a scratch location first (`SCRATCH=$(mktemp -d); cp -R /Users/prestonbernstein/dev/book-seller "$SCRATCH/copy"; cd "$SCRATCH/copy"`) and run there instead.

## The QA stack at a glance

| Tool | Command | Config | What it covers |
|---|---|---|---|
| Vitest (unit/component/API) | `npm test` (= `vitest run`), `npm run test:watch`, `npm run test:coverage` | `vitest.config.ts` | `lib/__tests__/*`, `tests/api/*`, `tests/integration.test.ts`, `components/__tests__/*`, `app/**/__tests__/*` |
| Playwright (E2E) | `npm run test:e2e` | `playwright.config.ts` | `tests/e2e/*.spec.ts` — 15 tests across 7 spec files, driven against a real `next dev` server on a scratch DB |
| Stryker (mutation testing) | `npm run test:mutation` (= `stryker run`) | `stryker.conf.json` | Mutates `lib/transitions.ts`, `lib/money.ts`, `lib/clothing.ts`, `lib/isbn.ts`, `lib/constants.ts`, `lib/dashboard.ts`, `lib/photos.ts`, `lib/imageOptimize.ts`, and `app/api/**/*.ts`; thresholds `high:90 / low:80 / break:75`; report at `reports/mutation/mutation.html` |
| fallow (dead-code / duplication / complexity) | `npm run analyze` (= `fallow check`) | `.fallowrc.json` | Whole repo; entry points are the Next.js App Router conventions (`app/**/page.{ts,tsx}`, `layout`, `route`, `middleware.ts`, `next.config.ts`); duplicate-reporting threshold `minOccurrences: 2` |
| TypeScript / ESLint | `npm run typecheck`, `npm run lint` | `tsconfig.json`, `eslint.config.mjs` | Standard static checks, not test-suite evidence but part of the gate |

Stryker and fallow are not test runners in the Vitest/Playwright sense — Stryker re-runs the Vitest suite under mutation, and fallow does static analysis without executing anything. Neither touches any database. Do NOT run `npm run test:mutation` casually — it re-executes the whole Vitest suite once per mutant and is slow; only run it when specifically asked to check mutation coverage, and read `reports/mutation/mutation.html` for the current score rather than trusting a memorized number here (mutation scores drift as code and tests change; this doc doesn't hardcode one).

## Vitest test inventory

| Location | File count | What it covers | Touches a DB? |
|---|---|---|---|
| `lib/__tests__/` | 8 files (`transitions`, `money`, `isbn`, `clothing`, `imageOptimize`, `dashboard`, `photos`, `backup`) | Pure/unit-level: state machine, cents/USD math, ISBN normalize + mocked-fetch lookup, clothing measurement validation, image resize, dashboard aggregation math, photo path helpers, backup routine (with a throwaway schema of its own — see the file) | No, except `photos.test.ts`/`backup.test.ts`, which use scratch dirs, not the real DB/photos tree |
| `tests/integration.test.ts` | 1 file, 935 lines | §1-4: re-runs of the transitions/money/isbn units, then direct-SQL lifecycle tests against the scratch DB (AC1-AC8 labels from the original books-only spec, still valid: ISBN entry, manual entry, price history, gross profit + full status lifecycle, Sold→Listed rejection, title search, condition filter, dashboard held total). §5: a **vestigial** `describe.skip('API integration ...')` block that predates `tests/api/*` (see below) — largely superseded, not the current pattern for HTTP-level tests | Yes — DB-integration tests, protected by the scratch-DB redirection above |
| `tests/api/*.ts` | 8 files (`items`, `items-id`, `items-status`, `items-photos`, `suggestions`, `import`, `export`, `isbn`) | **The real HTTP/route-handler test layer.** Each file imports the actual exported `GET`/`POST`/`PATCH`/`DELETE` handlers from `app/api/**/route.ts` and invokes them directly with constructed `NextRequest` objects — no running server, no port trap, nothing hardcoded to `localhost:3000`. This is what closed the old "unit tests are blind to route/constraint behavior" gap (see Evidence bar below) | Yes — same scratch-DB redirection |
| `components/__tests__/` | 7 files (`Dashboard`, `AddBookForm`, `AddClothingForm`, `ItemSearch`, `ThemeToggle`, `PhotoUpload`, `ItemCardGrid`) | React Testing Library component tests, `jsdom` environment via a `// @vitest-environment jsdom` docblock per file (the global default is `node`) | No |
| `app/__tests__/`, `app/dashboard/__tests__/`, `app/playbook/__tests__/`, `app/inventory/__tests__/`, `app/inventory/new/__tests__/`, `app/inventory/[id]/__tests__/` | 6 files | Page-level component tests for the home, dashboard, playbook, inventory list, new-item, and item-detail pages | No |

Rough current size: several hundred `it(`/`test(` cases across these files (spot-checked via `grep -c` per file; exact counts drift as tests are added — get the live number from `npm run test:coverage`'s summary line, which is now safe to run directly). Do not trust a specific hardcoded total in this doc; it will go stale the same way the original "139 passed, 15 skipped" figure did.

## Playwright E2E inventory

`tests/e2e/` — 7 spec files, 15 `test(` cases total: `book-flow.spec.ts` (2), `clothing-flow.spec.ts` (3), `csv-export-import.spec.ts` (3), `dashboard.spec.ts` (1), `photo-upload.spec.ts` (2), `playbook-and-nav.spec.ts` (3), `search-filter.spec.ts` (1). `playwright.config.ts` launches its own `next dev --turbopack -H 127.0.0.1 -p 3100` webServer with `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` pointed at `.playwright-scratch/`, `fullyParallel: false` and `workers: 1` (single-user app, no auth — tests share one server/DB, avoid cross-test races), `reuseExistingServer: false` (always fresh). Run with `npm run test:e2e`; this starts and stops its own server, so you do not need to `npm run dev` first.

## The vestigial skipped HTTP suite in tests/integration.test.ts

`tests/integration.test.ts` still has a `describe.skip('API integration (requires running server on localhost:3000)', ...)` block near the end (`const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000'`) that predates `tests/api/*.ts`. It is not maintained and not the current pattern — `tests/api/*.ts` already covers this layer without the port-trap/hardcoded-URL problems this block has. Leave it skipped; if you're tempted to un-skip and fix it, write the equivalent test in `tests/api/` instead (direct handler invocation, no server) and consider deleting the stale block as a follow-up (that's a source edit — route it through `resale-inventory-change-control`).

## Evidence bar

The defining historical lesson of this repo: **139 green tests once coexisted with two live API defects** (D1: status-transition 500 on missing `listing_price`; D2: import 500 that lost an entire valid batch over one duplicate ISBN) because the unit/DB-integration layers inserted rows directly with already-valid shapes, never exercising route-level validation against real HTTP requests. Both defects are now **fixed** (`docs/book-inventory-management/TASKS.md` Task 18, commits `94224e2`/`048f781`) and — more importantly — regression-locked: `tests/api/items-status.test.ts` and `tests/api/import.test.ts` explicitly test the missing-`listing_price` and duplicate-ISBN paths and assert the correct 4xx behavior (e.g. `import.test.ts`: "rejects duplicate ISBNs within the same file", "rejects an ISBN that already exists in inventory"). Green Vitest is still necessary, never automatically sufficient — but the specific gap that let D1/D2 ship silently (an entire skipped HTTP layer) is closed now that `tests/api/*` exercises real route handlers by default.

| Claim you are making | Minimum evidence |
|---|---|
| lib function correct | `lib/__tests__/` subset green, or `npm test` (now safe to run directly — see the DB-wipe section above) |
| Route/API behavior (status codes, bodies, error shapes) | A `tests/api/*.ts` test that invokes the real handler, OR an HTTP transcript against a confirmed-correct port (`curl` the actual route, paste request + response) |
| A defect is fixed | Reproduction from `resale-inventory-failure-archaeology` / `resale-inventory-constraint-leak-campaign` re-run showing the new behavior + a regression test added under `tests/api/` |
| Import/export correctness | Round-trip: export → import into a scratch DB → compare counts/fields (`tests/api/export.test.ts` and `import.test.ts` already do pieces of this; extend rather than re-derive) |
| UI behavior | A component test under `components/__tests__/` or `app/**/__tests__/`, or a Playwright spec under `tests/e2e/` for cross-page flows |
| Mutation coverage for a `lib/` or `app/api/` change | `reports/mutation/mutation.html` after `npm run test:mutation`, checked against the `stryker.conf.json` thresholds (`high:90 / low:80 / break:75`) |

Numbers before observations: write the expected status code and body BEFORE running the probe (`resale-inventory-analysis-and-methodology`, predict-then-observe).

## Coverage thresholds

`vitest.config.ts`'s `coverage` block (provider `v8`) sets:

```
statements: 85, branches: 80, functions: 85, lines: 85
```

scoped to `include: ['app/api/**/*.ts', 'app/**/page.tsx', 'lib/**/*.ts', 'components/**/*.tsx']`, excluding `lib/__tests__/**`, `lib/types.ts`, and `**/*.d.ts`. `app/**/page.tsx` is in scope — page-level components are not exempt from the threshold. These are deliberately strict and deliberately not necessarily met everywhere at any given moment; never lower them to make a run pass — write the missing tests or fix the code instead. Run `npm run test:coverage` to see the current numbers (safe: same scratch-DB redirection as `npm test`).

## How to add tests

- **Unit tests for `lib/`** → `lib/__tests__/<module>.test.ts`. Keep pure modules pure (no `lib/db` import, stub `fetch`) where the existing files do so; `photos.test.ts`/`backup.test.ts` are the exception and use real scratch directories, which is fine since those are protected by the same env-var redirection.
- **Route/API tests** → `tests/api/<route>.test.ts`, following the existing pattern: import the handler directly from `app/api/.../route.ts`, construct a `NextRequest`, assert on the `NextResponse`. This is now the standard pattern — do not add new `fetch()`-against-a-running-server tests inside `tests/integration.test.ts`'s skipped block.
- **DB-layer tests** → follow the existing pattern in `tests/integration.test.ts` §4 if you're testing something below the route layer; remember it shares the wipe-per-test `beforeEach`.
- **Component tests** → `components/__tests__/<Component>.test.tsx` or `app/<route>/__tests__/page.test.tsx`, with `// @vitest-environment jsdom` at the top of the file.
- **E2E tests** → `tests/e2e/<flow>.spec.ts`, Playwright `test()`/`expect()`, against the real running app (webServer in `playwright.config.ts` handles startup).
- Config facts: `vitest.config.ts` — `environment: 'node'` by default (jsdom opt-in per file), alias `@` → repo root (mirrored in `tsconfig.json`), `fileParallelism: false` (tests share one scratch DB file; parallel workers would race each other's `beforeEach` truncation and throw spurious FK errors).
- New tests that lock in a defect fix should quote the archaeology ID (D1/D2/T1/DR-N/…) in the test name or a comment, matching the existing convention in `tests/api/import.test.ts` and `items-status.test.ts`.
- Adding tests is a code change: gate per `resale-inventory-change-control` (usually the lightest class, but TASKS/record rules apply).

## When NOT to use this skill

- Triage of a failure you just saw → `resale-inventory-debugging-playbook`.
- Fixing a live defect itself → `resale-inventory-constraint-leak-campaign` (check its current status first — its two headline defects, D1/D2, are already fixed as of this writing).
- What gate a change needs → `resale-inventory-change-control`.
- GET-only health probes without tests → `resale-inventory-diagnostics-and-tooling`.
- Operating/backing up the DB → `resale-inventory-run-and-operate`.

## Provenance and maintenance

Originally authored 2026-07-02 against a single-category (books-only), pre-Playwright/pre-Stryker/pre-fallow build with a 139-passed/15-skipped Vitest suite and no configurable DB path. Refreshed after the multi-category migration and the QA-hardening pass: verified by reading `vitest.config.ts`, `playwright.config.ts`, `stryker.conf.json`, `.fallowrc.json`, `package.json` scripts, `tests/integration.test.ts` (all 935 lines, including the still-present but vestigial skipped block), the full `tests/api/*.ts` directory, and `lib/db.ts`/`lib/photos.ts`'s env-var resolution; cross-checked against `git log` (T1, D1/D2/D3, DR-1/2/3/4/7 fix commits) and `docs/book-inventory-management/TASKS.md`.

Re-verify:
- Wipe mechanism still present (expected — it's not the danger anymore, the redirection is what matters): `grep -n "DELETE FROM item_photos" tests/integration.test.ts`.
- DB-path redirection still wired: `grep -n "BOOKSELLER_DB_PATH" vitest.config.ts playwright.config.ts lib/db.ts`.
- `tests/api/*` still the live HTTP-layer suite (not skipped): `grep -L "describe.skip" tests/api/*.ts` (expect all 8 files listed — none should be skip-wrapped).
- Old skipped block still isolated to `tests/integration.test.ts` §5: `grep -n "describe.skip" tests/integration.test.ts`.
- Coverage thresholds: `grep -n "statements:\|branches:\|functions:\|lines:" vitest.config.ts`.
- Mutation scope/thresholds: `grep -n "\"mutate\"\|\"thresholds\"" stryker.conf.json`.
