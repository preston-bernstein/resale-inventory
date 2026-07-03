---
name: book-seller-validation-and-qa
description: How to run book-seller's tests WITHOUT destroying real data, what counts as evidence here, acceptance-criteria coverage, and how to add tests. Load BEFORE running any test command in this repo - "run tests", "vitest", "is it safe to run tests", "add a test", "verify a change", "acceptance criteria", "QA", "why did tests pass but the API is broken". The test suite wipes the real database; this skill owns the safe procedure.
---

# Book-Seller — Validation and QA

## THE WIPE WARNING (read this first)

**`npx vitest run` from the repo root DELETES ALL INVENTORY DATA.**

Mechanism, verified 2026-07-02: `tests/integration.test.ts` → `describe('DB integration')` → `beforeEach` runs

```ts
db.exec('DELETE FROM price_history; DELETE FROM book_platforms; DELETE FROM books;');
```

and `db` is the real connection: `lib/db.ts` opens `process.cwd() + '/data/inventory.db'`. There is no test database, no automated backup, and everything under `data/` is gitignored — git cannot restore it. The current DB contents are already just residue left by a past test run (one 'Test Book' row).

**Iron rule: never run the full suite, or `tests/integration.test.ts`, from the repo root.** Use one of the two safe procedures below. (T1 in `book-seller-failure-archaeology`; the durable fix — an env-configurable DB path — is a CANDIDATE change, see "Candidate fix" below.)

## Safe procedure A — lib-only subset, in-repo (fast, verified safe)

The three files under `lib/__tests__/` import only pure modules (`../isbn`, `../money`, `../transitions` — verified: none imports `lib/db`; the ISBN tests stub `fetch` with `vi.stubGlobal`, so no network either). Safe to run in place:

```bash
cd /Users/prestonbernstein/dev/book-seller
npx vitest run lib/__tests__
# Verified 2026-07-02:
#  Test Files  3 passed (3)
#       Tests  64 passed (64)
```

DB row count confirmed identical before and after. Use this for quick iteration on `lib/` code.

## Safe procedure B — full suite, in a scratch copy (the standard)

Copy the whole repo (including `node_modules` — same machine, native modules stay valid) to a scratch location and run there. The copy gets its own `data/inventory.db`; the wipe hits the copy.

```bash
SCRATCH=$(mktemp -d)
cp -R /Users/prestonbernstein/dev/book-seller "$SCRATCH/bs-test"
cd "$SCRATCH/bs-test"
npx vitest run
# Verified 2026-07-02 (expected numbers):
#  Test Files  4 passed (4)
#       Tests  139 passed | 15 skipped (154)
cd / && rm -rf "$SCRATCH"
```

If the numbers differ from 139/15 (plus any tests added since 2026-07-02), stop and investigate before trusting anything else. Real-DB row count verified unchanged by this procedure.

### Candidate fix (do NOT implement without gating)

Make the DB path configurable (`process.env.BOOKSELLER_DB_PATH ?? cwd default` in `lib/db.ts`) so tests can point at a temp file. Behavior-adjacent → route through `book-seller-change-control`; config axis rules in `book-seller-config-and-constants`. Status: CANDIDATE, unimplemented as of 2026-07-02.

## Test inventory

| File | Layer | Covers | Count (2026-07-02) | Touches real DB? |
|---|---|---|---|---|
| `lib/__tests__/transitions.test.ts` | unit | state machine valid/invalid paths, set sizes | part of 64 | No |
| `lib/__tests__/money.test.ts` | unit | cents/USD conversions, rounding, bounds | part of 64 | No |
| `lib/__tests__/isbn.test.ts` | unit | normalizeISBN, lookupISBN with mocked fetch (timeout, 64 KB cap, malformed) | part of 64 | No (fetch stubbed) |
| `tests/integration.test.ts` §§1–4 | unit + DB integration | re-runs transition/money/isbn units, then direct-SQL lifecycle tests | ~75 run | **YES — wipes tables** |
| `tests/integration.test.ts` §5 | HTTP API | `describe.skip('API integration ...')`, 14 tests, AC-labeled | skipped | Would mutate whatever DB the target server uses |
| (1 more skip) | — | `it.skip('lookupISBN — network call skipped in unit mode')` | skipped | — |

## The skipped HTTP API suite — activation procedure

The suite hardcodes `const base = 'http://localhost:3000'`. **Three-layer warning chain:**

1. **Port trap:** :3000 on this machine usually serves an unrelated Flutter app that answers HTTP 200 with HTML. Unskip-and-run without checking = you "test" the wrong server. Confirm with `scripts/find-port.sh` (`book-seller-diagnostics-and-tooling`) or `curl -s http://localhost:3000/api/dashboard | head -c 40` (must start `{"held_count"`).
2. **Mutation:** the suite POSTs books, imports CSVs, and records sales against the live server's DB.
3. **Repo hygiene:** removing `.skip` is a source edit — do it only in a scratch copy (procedure B), never leave it in the repo.

Correct procedure: scratch copy → start `npx next dev --turbopack -H 127.0.0.1 -p 3005` inside the copy → edit `base` to `http://127.0.0.1:3005` and remove `.skip` in the copy → `npx vitest run tests/integration.test.ts` → kill server → delete copy.

## Evidence bar

The defining lesson of this repo (2026-07-02): **139 green tests coexisted with two live API defects.** The unit/DB layers never exercise route validation against DB CHECK constraints — the DB-integration tests insert rows directly with valid shapes (e.g., `listing_price` already set), so the route-level gaps (Defects D1/D2, see `book-seller-failure-archaeology`) were invisible. Green vitest is necessary, never sufficient.

| Claim you are making | Minimum evidence |
|---|---|
| lib function correct | lib-only subset green (procedure A) |
| Anything touching DB code paths | procedure B green |
| API behavior (status codes, bodies, error shapes) | **HTTP transcript against a confirmed-correct port** — curl the actual route, paste request + response |
| A defect is fixed | Reproduction from `book-seller-failure-archaeology` re-run showing the new behavior + regression test added |
| Import/export correctness | Round-trip: export → import into scratch server → compare counts/fields |

Numbers before observations: write the expected status code and body BEFORE running the probe (`book-seller-analysis-and-methodology`, predict-then-observe).

## Acceptance-criteria coverage (requirements.md, 11 ACs)

| AC | Automated coverage (test names, 2026-07-02) | Status |
|---|---|---|
| AC1 (ISBN → populated record, Unlisted) | DB-layer: "AC1: entry with ISBN stores isbn column…" — but ISBN *lookup* path only via mocked unit tests | Partial (no live-provider test by design) |
| AC2 (manual entry works) | "AC2: manual entry without ISBN…" + skipped HTTP twin | Covered |
| AC3 (sale records profit) | "AC3: full lifecycle Unlisted → Listed → Sale Pending → Sold" | Covered — **note: tests encode the two-step flow, siding with FR10/code against AC3's literal Listed→Sold text (open owner decision, SR-6 in failure-archaeology)** |
| AC4 (Sold→Listed rejected) | unit + DB + skipped HTTP twin | Covered |
| AC5 (price history) | "AC5: price change creates price_history entry…" ×2 | Covered |
| AC6 (case-insensitive title search) | DB-layer LIKE test + skipped HTTP twin | Covered |
| AC7 (condition filter) | DB-layer + skipped HTTP twin | Covered |
| AC8 (dashboard held totals) | "AC8: held total = sum…" | Covered |
| AC9 (import 48/2 per-row errors) | ONLY in the skipped HTTP suite | **Not exercised in default runs. Worse: the FR22 guarantee behind it ("without aborting the entire batch") is LIVE-VIOLATED for duplicate-ISBN errors (Defect D2)** — AC9's literal missing-fields scenario is handled, the guarantee is not |
| AC10 (export completeness) | ONLY in the skipped HTTP suite | Not exercised in default runs |
| AC11 (lookup outage → manual entry) | mocked-timeout unit tests + skipped HTTP twin | Covered at unit level |

## How to add tests

- **Unit tests for `lib/`** → `lib/__tests__/<module>.test.ts`. Keep them pure: no `lib/db` import, stub `fetch`. These stay safe to run in-repo.
- **DB-layer tests** → follow the existing pattern in `tests/integration.test.ts` §4, but remember anything there inherits the wipe and the procedure-B requirement.
- **HTTP tests** → follow the existing `describe.skip` pattern; make the base URL configurable (`process.env.TEST_BASE_URL ?? 'http://localhost:3000'`) so the port trap is escapable — the hardcoded base is a known weakness.
- Config facts: `vitest.config.ts` — `environment: 'node'`, alias `@` → repo root (mirrored in `tsconfig.json`).
- New tests that lock in a defect fix should quote the archaeology ID (D1/D2/…) in the test name.
- Adding tests is a code change: gate per `book-seller-change-control` (usually the lightest class, but TASKS/record rules apply).

## When NOT to use this skill

- Triage of a failure you just saw → `book-seller-debugging-playbook`.
- Fixing D1/D2 themselves → `book-seller-constraint-leak-campaign` (it has the gated reproduction + regression-lock protocol).
- What gate a change needs → `book-seller-change-control`.
- GET-only health probes without tests → `book-seller-diagnostics-and-tooling`.
- Operating/backing up the DB → `book-seller-run-and-operate`.

## Provenance and maintenance

Authored 2026-07-02. Verified that day by execution: procedure A output (64 passed, DB row count unchanged); procedure B output (139 passed | 15 skipped in a scratch copy, real DB unchanged); test-file import inspection; the hardcoded `base` URL; AC labels via grep.

Re-verify:
- Counts: run procedure B (never in-repo) — expect 139+N/15 as tests are added.
- lib-tests still pure: `grep -l "lib/db\|from '../db'" lib/__tests__/*.ts` (expect no hits).
- Wipe still present: `grep -n "DELETE FROM price_history" tests/integration.test.ts`.
- Skipped-suite base URL: `grep -n "const base" tests/integration.test.ts`.
- AC labels: `grep -c "AC[0-9]" tests/integration.test.ts`.
- Candidate DB-path fix still unimplemented: `grep -n "process.env" lib/db.ts` (expect no hits).
