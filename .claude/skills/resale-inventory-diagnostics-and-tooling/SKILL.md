---
name: resale-inventory-diagnostics-and-tooling
description: Measurement tools for the resale-inventory repo (formerly resale-inventory) - four tested, read-only scripts (find the real port, GET-only API smoke suite, database invariant sweep, constants-drift detector) with interpretation guides. Use when asked "is the app up", "which port", "smoke test", "health check", "check the database", "integrity check", "did the constants drift", or whenever you are tempted to eyeball behavior instead of measuring it.
---

# Resale Inventory — Diagnostics and Tooling

Measure, don't eyeball. Every script here is **read-only**: GET-only HTTP, `mode=ro` SQLite, or plain `grep`. Safe to run any time, including against live data with the server up.

The object lesson for why shape-checks beat status-code checks in this repo: an unrelated local app has historically squatted on port 3000 and answered **HTTP 200** to any path. A "200 OK" is not proof of anything. `find-port.sh` therefore requires the `/api/dashboard` JSON signature (`held_count`), not a status code.

**Schema note:** all four scripts already target the current multi-category schema (`items`/`book_details`/`clothing_details`/`item_platforms`/`item_photos`/`price_history`) and the current `/api/items` routes, not the original single-category `books`/`book_platforms`/`/api/books` shape. If you ever see `books`/`book_platforms`/`/api/books` in one of these scripts, that's a regression back to the pre-migration schema — treat it as a bug in the script, not as current-state truth.

## Quick start

| Script | What it measures | Safe? | Typical runtime |
|---|---|---|---|
| `scripts/find-port.sh` | Which port (3000–3010) actually serves this app | GET-only | <5 s |
| `scripts/api-smoke.sh [port]` | Five API contract probes (shapes + guard behaviors) against `/api/items`, `/api/dashboard`, `/api/isbn`, `/api/export` | GET-only | <10 s |
| `scripts/db-integrity.sh [repo-root]` | DB invariants: integrity, orphans, per-category detail-row presence, CHECK-class violations, dup ISBNs | mode=ro | <2 s |
| `scripts/constants-drift.sh [repo-root]` | Duplicated-constant home counts vs recorded baselines; known-gap sentinels (middleware, env-var usage) | grep-only | <2 s |

Run from anywhere; scripts default to the repo at `/Users/prestonbernstein/dev/resale-inventory`:

```bash
cd /Users/prestonbernstein/dev/resale-inventory
.claude/skills/resale-inventory-diagnostics-and-tooling/scripts/find-port.sh
```

All scripts exit 0 on clean, 1 on any failure — safe to chain in shell logic.

## find-port.sh

Probes 127.0.0.1 ports 3000–3010 with `GET /api/dashboard` and prints the first port whose body contains `"held_count"`.

With no server running (a real, current run of this script, read-only/no side effects):

```
resale-inventory not found on ports 3000-3010 (is the server running? npm run dev)
```
(exit 1)

| Result | Meaning | Next step |
|---|---|---|
| A port number, exit 0 | The app found there | Use it |
| Error line, exit 1 | Not serving on 3000–3010 | `npm run dev` (see `resale-inventory-run-and-operate`); if you believe it IS running, check its startup log for the real port or `lsof -nP -iTCP -sTCP:LISTEN \| grep -i node` |
| Returns 3000 | The app really is on 3000 (nothing else squatting on it today) | Fine — the signature check makes this trustworthy |

Note `npm run dev` now binds `127.0.0.1` only by default (DR-4, fixed), so this script's `127.0.0.1`-only probing already matches how the app actually listens.

## api-smoke.sh

Five GET-only probes against the current routes, each verified against route source before scripting. Requires a server running (start one per `resale-inventory-run-and-operate`, or let this script auto-detect via `find-port.sh`); it does not start one itself.

```
PASS  GET /api/dashboard returns held_count/held_acquisition_cost/by_condition/by_status
PASS  GET /api/items returns items/total/page/limit envelope
PASS  GET /api/items?limit=999 -> HTTP 400 (got 400)
PASS  GET /api/isbn/notanisbn -> HTTP 400 Invalid ISBN format (got 400)
PASS  GET /api/export -> text/csv + attachment disposition
----
SMOKE: all checks passed on port <port>
```

(Expected shapes verified by reading `app/api/dashboard/route.ts` + `lib/dashboard.ts`, `app/api/items/route.ts`, `app/api/isbn/[isbn]/route.ts`, and `app/api/export/route.ts` directly — not a fabricated transcript. `/api/dashboard`'s real body now also includes a `by_category` key beyond what this script checks for; the script only asserts the four keys shown, so it will still PASS even though the shape has grown.)

Interpretation per failure:

| FAIL line | Likely cause | Go to |
|---|---|---|
| dashboard shape | Wrong target (another app's HTML), or dashboard route changed | `find-port.sh`; then `resale-inventory-debugging-playbook` |
| items envelope | Route contract changed without spec — that's a gated change | `resale-inventory-change-control` |
| limit=999 not 400 | Bounds validation removed/altered in `app/api/items/route.ts` | `resale-inventory-config-and-constants` ledger + change-control |
| ISBN 400 probe | Pattern validation changed (2 homes — may have drifted apart) | `constants-drift.sh`, then ledger |
| export headers | Export route changed; CSV consumers (import round-trip!) at risk | `resale-inventory-change-control` |

Note: the smoke suite deliberately contains **no probe for the old D1/D2 constraint-leak 500s** — those required mutating requests to trigger, and both are fixed now anyway (see `resale-inventory-debugging-playbook`). Their historical gated reproduction protocol lived in `resale-inventory-constraint-leak-campaign`.

## db-integrity.sh

Read-only sweep against `items`/`book_details`/`clothing_details`/`item_platforms`/`item_photos`/`price_history`. The middle checks ("CHECK-guaranteed") should be structurally impossible to fail while the schema's CHECK constraints stand — a non-zero there means schema tampering or a bypassed write path, which is a five-alarm finding. It also checks a multi-category-specific invariant: every item has exactly one matching row in `book_details` or `clothing_details` per its `category`.

Real run, this session, read-only against the actual `data/inventory.db`:

```
== PRAGMA integrity_check (expect: ok)
ok
== Orphan item_platforms rows (expect: 0)
0
== Orphan item_photos rows (expect: 0)
0
== Orphan price_history rows (expect: 0)
0
== Items missing their category's satellite detail row (expect: 0 — every item must have exactly one of book_details/clothing_details)
0
== Listed/Sale Pending rows missing listing_price (expect: 0 — CHECK-guaranteed)
0
== Sold rows missing sale fields (expect: 0 — CHECK-guaranteed)
0
== Rows outside status enum (expect: 0 — CHECK-guaranteed)
0
== book_details rows outside the book condition enum (expect: 0 — CHECK-guaranteed)
0
== clothing_details rows outside the clothing condition enum (expect: 0 — CHECK-guaranteed)
0
== Duplicate non-null ISBNs (expect: 0 — unique-index-guaranteed)
0
== Row counts per status (informational)
Listed|1
== Row counts per category (informational)
book|1
== Totals: items / item_platforms / item_photos / price_history (informational)
1|1|0|0
----
DB-INTEGRITY: clean
```

(Matches the real DB's current contents: one `book`-category item, status `Listed`, one platform row, no photos, no price history — the same single `Test Book` fixture referenced elsewhere in this skill library. `PRAGMA user_version` on this DB is `3`, meaning all three migrations, including the multi-category rebuild, have already been applied to it — it is not sitting at a pre-migration `books`/`book_platforms` schema.)

Contents of the informational sections vary with real inventory — the invariant checks do not.

| Violation | Meaning | Go to |
|---|---|---|
| integrity_check != ok | File corruption | STOP; operator restores from backup (`resale-inventory-run-and-operate`) |
| Orphans > 0 | Writes happened with `foreign_keys` OFF (pragma removed?) | `resale-inventory-architecture-contract` invariants; check `lib/db.ts` pragmas |
| Missing satellite detail row > 0 | A row was inserted into `items` without its matching `book_details`/`clothing_details` row — likely a bypassed insert path, not something the normal API routes can produce (they insert both in one transaction) | `resale-inventory-failure-archaeology` — record it; `resale-inventory-change-control` |
| CHECK-guaranteed > 0 | Schema was weakened, or rows predate a constraint | `resale-inventory-failure-archaeology` — record it; `resale-inventory-change-control` — someone routed around gates |
| Dup ISBNs > 0 | Unique index dropped/violated | Same escalation |

## constants-drift.sh

Compares grep counts of the duplicated constants against recorded baselines, plus two sentinels (`middleware.ts` presence — CSRF Origin-check, DR-1; count of files reading `process.env` — the `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` test-safety overrides plus a couple of other reads, T1-adjacent). Both sentinels were flipped from their original meaning once those fixes landed: the original baseline treated `middleware.ts` absence and zero `process.env` reads as the expected ("known gap") state; the current baseline treats their presence as expected instead.

Real run, this session, grep-only:

```
OK    condition-vocabulary file homes ('Like New') = 5
OK    ISBN_PATTERN homes = 2
OK    date-regex file homes = 1
OK    money-cap file homes (incl. lib/__tests__ assertions) = 5
OK    lib/db.ts pragmas (WAL + foreign_keys) = 2
OK    middleware.ts present (DR-1 fix, CSRF Origin check)
OK    files reading process.env in app/+lib/ (BOOKSELLER_DB_PATH/BOOKSELLER_PHOTOS_PATH overrides + others) = 5
----
CONSTANTS-DRIFT: no drift vs 2026-07-12 baselines
```

The condition-vocabulary and date-regex counts dropped from their original single-category values (9 and 3 respectively) because `DATE_RE` and the book condition vocabulary were deduped into `lib/constants.ts` during later hardening work — fewer homes is the improvement this script is designed to detect and then have its baseline updated to match, which already happened here.

DRIFT is not automatically bad — it means reality moved and documentation must follow: update the `resale-inventory-config-and-constants` ledger, then the baselines in this script, in the same change. A DRIFT on the `middleware.ts` sentinel now (i.e., it goes missing) would be BAD news — a CSRF-protection regression — the opposite of what the original 2026-07-02 version of this script treated as good news.

## Measuring instead of eyeballing — house rules

1. Never trust an HTTP 200 without a body-shape check (the impostor-app-on-3000 lesson).
2. Never claim "the API works" from unit tests alone — see `resale-inventory-validation-and-qa` evidence bar (the historical D1/D2 defects shipped under a fully-green unit suite).
3. Before/after any risky operation, snapshot: `db-integrity.sh` output + row counts. Diff afterwards.
4. Write the expected output BEFORE running the probe (`resale-inventory-analysis-and-methodology`, predict-then-observe).

## When NOT to use this skill

- Something already failed and you need triage → `resale-inventory-debugging-playbook` (it uses these scripts, plus symptom mapping).
- You need to check whether a historical constraint-leak defect is really fixed → `resale-inventory-constraint-leak-campaign` / `resale-inventory-debugging-playbook` (spoiler: D1/D2/D3 already are, as of this writing).
- Running the test suite → `resale-inventory-validation-and-qa` (now safe to run directly from the repo root by default — see that skill for why).
- Operating/backing up → `resale-inventory-run-and-operate`.

## Provenance and maintenance

Originally authored 2026-07-02 against a single-category (books-only) build, with all four scripts targeting `/api/books` and the `books`/`book_platforms` tables. The scripts themselves were subsequently updated in place to the current multi-category schema and routes (visible in their own headers/comments, dated 2026-07-12) — this refresh of the SKILL.md brings the surrounding documentation and sample outputs back in sync with what the scripts actually do now, verified by reading all four scripts in full and by actually running `find-port.sh`, `db-integrity.sh`, and `constants-drift.sh` live (read-only/grep-only, no DB writes, no server started) against this repo.

Re-verify:
- Scripts still pass: run all four (start a server first for `api-smoke.sh`; the other three need no server).
- Scripts still target the current schema/routes, not a regression back to `books`/`/api/books`: `grep -l "FROM books\b\|/api/books" .claude/skills/resale-inventory-diagnostics-and-tooling/scripts/*.sh` (expect no output).
- Smoke expectations still match code: `grep -n "limit must be 1–200\|Invalid ISBN format" app/api/items/route.ts "app/api/isbn/[isbn]/route.ts"`.
- Drift baselines: the script IS the re-verification; on DRIFT, update ledger + baselines together.
- If routes are added/renamed, extend `api-smoke.sh` (GET-only rule stands) and update this guide.
