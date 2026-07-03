---
name: book-seller-diagnostics-and-tooling
description: Measurement tools for the book-seller repo - four tested, read-only scripts (find the real port, GET-only API smoke suite, database invariant sweep, constants-drift detector) with interpretation guides. Use when asked "is the app up", "which port", "smoke test", "health check", "check the database", "integrity check", "did the constants drift", or whenever you are tempted to eyeball behavior instead of measuring it.
---

# Book-Seller — Diagnostics and Tooling

Measure, don't eyeball. Every script here is **read-only**: GET-only HTTP, `mode=ro` SQLite. Safe to run any time, including against live data with the server up.

The object lesson for why shape-checks beat status-code checks in this repo: port 3000 is usually held by an unrelated Flutter app that answers **HTTP 200** to any path. A "200 OK" from :3000 proves nothing. `find-port.sh` therefore requires the `/api/dashboard` JSON signature (`held_count`), not a status code.

## Quick start

| Script | What it measures | Safe? | Typical runtime |
|---|---|---|---|
| `scripts/find-port.sh` | Which port (3000–3010) actually serves book-seller | GET-only | <5 s |
| `scripts/api-smoke.sh [port]` | Five API contract probes (shapes + guard behaviors) | GET-only | <10 s |
| `scripts/db-integrity.sh [repo-root]` | DB invariants: integrity, orphans, CHECK-class violations, dup ISBNs | mode=ro | <2 s |
| `scripts/constants-drift.sh [repo-root]` | Duplicated-constant home counts vs 2026-07-02 baselines; known-gap sentinels | grep-only | <2 s |

Run from anywhere; scripts default to the repo at `/Users/prestonbernstein/dev/book-seller`:

```bash
cd /Users/prestonbernstein/dev/book-seller
.claude/skills/book-seller-diagnostics-and-tooling/scripts/find-port.sh
```

All scripts exit 0 on clean, 1 on any failure — safe to chain in shell logic.

## find-port.sh

Probes 127.0.0.1 ports 3000–3010 with `GET /api/dashboard` and prints the first port whose body contains `"held_count"`.

Real run (2026-07-02, server started with `-p 3006`, Flutter app live on :3000):

```
3006
```

| Result | Meaning | Next step |
|---|---|---|
| A port number, exit 0 | book-seller found there | Use it |
| Error line, exit 1 | Not serving on 3000–3010 | `npm run dev` (see `book-seller-run-and-operate`); if you believe it IS running, check its startup log for the real port or `lsof -nP -iTCP -sTCP:LISTEN | grep -i node` |
| Returns 3000 | book-seller really is on 3000 (Flutter absent today) | Fine — the signature check makes this trustworthy |

## api-smoke.sh

Five GET-only probes, each verified against route code before scripting. Real run (2026-07-02, port 3006):

```
PASS  GET /api/dashboard returns held_count/held_acquisition_cost/by_condition/by_status
PASS  GET /api/books returns items/total/page/limit envelope
PASS  GET /api/books?limit=999 -> HTTP 400 (got 400)
PASS  GET /api/isbn/notanisbn -> HTTP 400 Invalid ISBN format (got 400)
PASS  GET /api/export -> text/csv + attachment disposition
----
SMOKE: all checks passed on port 3006
```

Interpretation per failure:

| FAIL line | Likely cause | Go to |
|---|---|---|
| dashboard shape | Wrong target (Flutter HTML), or dashboard route changed | `find-port.sh`; then `book-seller-debugging-playbook` |
| books envelope | Route contract changed without spec — that's a gated change | `book-seller-change-control` |
| limit=999 not 400 | Bounds validation removed/altered in `app/api/books/route.ts` | `book-seller-config-and-constants` ledger + change-control |
| ISBN 400 probe | Pattern validation changed (2 homes — may have drifted apart) | `constants-drift.sh`, then ledger |
| export headers | Export route changed; CSV consumers (import round-trip!) at risk | `book-seller-change-control` |

Note: the smoke suite deliberately contains **no probe for Defects D1/D2** — those require mutating requests. Their gated reproduction lives in `book-seller-constraint-leak-campaign`.

## db-integrity.sh

Read-only sweep. The middle checks ("CHECK-guaranteed") should be structurally impossible to fail while the schema's CHECK constraints stand — a non-zero there means schema tampering or a bypassed write path, which is a five-alarm finding.

Real run (2026-07-02, residue DB — one Test Book row):

```
== PRAGMA integrity_check (expect: ok)
ok
== Orphan book_platforms rows (expect: 0)
0
== Orphan price_history rows (expect: 0)
0
== Listed/Sale Pending rows missing listing_price (expect: 0 — CHECK-guaranteed)
0
== Sold rows missing sale fields (expect: 0 — CHECK-guaranteed)
0
== Rows outside status/condition enums (expect: 0 — CHECK-guaranteed)
0
== Duplicate non-null ISBNs (expect: 0 — unique-index-guaranteed)
0
== Row counts per status (informational)
Listed|1
== Totals: books / platforms / price_history (informational)
1|1|0
```

Contents of the informational sections vary with real inventory — the invariant checks do not.

| Violation | Meaning | Go to |
|---|---|---|
| integrity_check != ok | File corruption | STOP; operator restores from backup (`book-seller-run-and-operate`) |
| Orphans > 0 | Writes happened with `foreign_keys` OFF (pragma removed?) | `book-seller-architecture-contract` invariants; check `lib/db.ts` pragmas |
| CHECK-guaranteed > 0 | Schema was weakened, or rows predate a constraint | `book-seller-failure-archaeology` — record it; `book-seller-change-control` — someone routed around gates |
| Dup ISBNs > 0 | Unique index dropped/violated | Same escalation |

## constants-drift.sh

Compares grep counts of the duplicated constants against hardcoded 2026-07-02 baselines, plus two sentinels (middleware.ts absence = known gap DR-1; zero `process.env` reads = config model unchanged). Real run (2026-07-02):

```
OK    condition-vocabulary file homes ('Like New') = 9
OK    ISBN_PATTERN homes = 2
OK    date-regex file homes = 3
OK    money-cap file homes (incl. lib/__tests__ assertions) = 5
OK    lib/db.ts pragmas (WAL + foreign_keys) = 2
OK    middleware.ts still absent (known gap DR-1)
OK    files reading process.env in app/+lib/ (config model unchanged) = 0
----
CONSTANTS-DRIFT: no drift vs 2026-07-02 baselines
```

DRIFT is not automatically bad — it means reality moved and documentation must follow: update the `book-seller-config-and-constants` ledger, then the baselines in this script, in the same change. A DRIFT on the middleware sentinel is good news (DR-1 fixed) — update `book-seller-failure-archaeology` and remove the gap from the skills that cite it.

## Measuring instead of eyeballing — house rules

1. Never trust an HTTP 200 without a body-shape check (the Flutter lesson).
2. Never claim "the API works" from unit tests — see `book-seller-validation-and-qa` evidence bar.
3. Before/after any risky operation, snapshot: `db-integrity.sh` output + row counts. Diff afterwards.
4. Write the expected output BEFORE running the probe (`book-seller-analysis-and-methodology`, predict-then-observe).

## When NOT to use this skill

- Something already failed and you need triage → `book-seller-debugging-playbook` (it uses these scripts, plus symptom mapping).
- You need to reproduce/fix D1/D2 (mutating probes) → `book-seller-constraint-leak-campaign`.
- Running the test suite → `book-seller-validation-and-qa` (wipe warning).
- Operating/backing up → `book-seller-run-and-operate`.

## Provenance and maintenance

Authored 2026-07-02. All four scripts executed for real that day against a dev server on port 3006 (`npx next dev --turbopack -H 127.0.0.1 -p 3006`, killed afterwards); outputs above are genuine, not simulated. Expected API behaviors verified against route sources before scripting.

Re-verify:
- Scripts still pass: run all four (start a server first for the HTTP two).
- Smoke expectations still match code: `grep -n "limit must be 1–200\|Invalid ISBN format" app/api/books/route.ts "app/api/isbn/[isbn]/route.ts"`.
- Drift baselines: the script IS the re-verification; on DRIFT, update ledger + baselines together.
- If routes are added/renamed, extend api-smoke.sh (GET-only rule stands) and update this guide.
