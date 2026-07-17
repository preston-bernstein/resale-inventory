---
name: resale-inventory-analysis-and-methodology
description: First-principles analysis recipes for resale-inventory (formerly resale-inventory) with worked examples from its real history - constraint-coverage audit (would have caught both live defects), money-arithmetic proofs, state-machine analysis, predict-then-observe protocol, one-mechanism evidence rule, idea lifecycle. Use when asked to "prove", "verify correctness", "audit constraints", form a "hypothesis", do "root cause analysis", ask "why did tests miss this", or set the "evidence bar".
---

# Book-Seller — Analysis and Methodology

How to KNOW things about this codebase instead of believing them. Each method is a recipe with a worked example drawn from this repo's actual history — the examples are real, dated, and re-runnable.

## 1. Constraint-coverage audit (flagship — this catches the defect class this repo actually shipped)

**When:** after any schema change, route change, or when auditing API robustness. This is the method that, run before 2026-07-02, would have caught Defects D1 and D2 pre-ship — and the fix campaign (D1-D4, all FIXED 2026-07-03) closed every gap this audit found. Re-run it after any *new* schema or route change; a fixed audit table is a point-in-time result, not a permanent guarantee.

**Steps:**
1. Enumerate every DB-level rule across `data/migrations/*.sql` (currently `001_init.sql`, `002_price_history_nullable.sql`, `003_multi_category.sql` — the live schema is `items`/`book_details`/`clothing_details`/`item_photos`/`item_platforms`/`price_history`, not the original `books`/`book_platforms`): each CHECK, each conditional NOT NULL, each unique index, each FK.
2. For each rule × each write route that can trigger it: does the route pre-validate to a clean 4xx? Does any test exercise that path end-to-end?
3. Every (rule, route) pair with "no guard" is a latent opaque-500 (the route's catch-all converts the SqliteError).

**Worked example — the original audit table that found the defects (2026-07-02, against the then-current `books`/`book_platforms` schema and `app/api/books/**` routes — kept verbatim as the worked example; the schema and routes have since been rebuilt to `items`/`app/api/items/**` by migration 003, and every uncovered pair below now has a guard):**

| DB rule (001_init.sql, books-era) | Triggerable via | Route guard → 4xx? | End-to-end test? | Verdict (2026-07-02) | Current status |
|---|---|---|---|---|---|
| `condition IN (…)` CHECK | books POST, [id] PATCH, import | Yes (all three validate) | DB-layer + skipped HTTP | Covered | Covered (now on book_details/clothing_details) |
| `status IN (…)` CHECK | status POST | Yes (VALID_STATUSES → 422) | unit + DB-layer | Covered | Covered |
| `acquisition_date LIKE '____-__-__'` | books POST, import | Yes (DATE_RE, stricter) | DB-layer | Covered | Covered |
| `sale_date` shape CHECK | status POST (Sold) | Yes (DATE_RE when Sold) | — | Covered | Covered |
| `created_at`/`updated_at` shape CHECKs | code-set only (ISO strings / `datetime('now')`) | n/a — not user-reachable | — | Covered structurally | Covered structurally |
| NOT NULL title/author/acquisition_cost | books POST, import | Yes (required-field validation) | DB-layer + import errors | Covered | Covered |
| **`status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL`** | **status POST (→Listed/Sale Pending)** | **NO** | **none** | **UNCOVERED → Defect D1** | **FIXED (2026-07-03): `app/api/items/[id]/status/route.ts` checks `listing_price IS NOT NULL` before allowing →Listed/Sale Pending, returns 422** |
| same CHECK | **[id] PATCH (`listing_price: null` on Listed)** | **NO ("allow clearing to null")** | none | **UNCOVERED → suspected D3** | **FIXED (2026-07-03, confirmed live then patched): PATCH route rejects clearing `listing_price` to null while Listed/Sale Pending, 422** |
| `sale_price/sale_date/sale_platform NOT NULL when Sold` CHECKs ×3 | status POST | Yes (explicit 422) | unit-level | Covered | Covered |
| **`idx_books_isbn` UNIQUE (partial: `WHERE isbn IS NOT NULL`, now `idx_book_details_isbn`)** | books POST | Yes (pre-SELECT → 409) | — | Covered | Covered |
| same index | **import POST** | **NO (no normalizeISBN, no dup check)** | none | **UNCOVERED → Defect D2** | **FIXED (2026-07-03): `app/api/import/route.ts` calls `normalizeISBN` per row, tracks in-file duplicates, checks against the DB — per-row 4xx errors, valid rows still commit** |
| FK `book_platforms.book_id` / `price_history.book_id` (now `item_platforms.item_id` / `price_history.item_id`) | PATCH platform/price writes | Structural (`foreign_keys = ON` + fetch-before-write) | db-integrity.sh orphan checks | Covered | Covered |

**Headline (as run 2026-07-02): ~12 rule groups; 3 uncovered (rule, route) pairs; all 3 corresponded exactly to the live defect cluster.** The audit's negative space WAS the bug list. Fix record: `resale-inventory-failure-archaeology` (D1-D4). Note the unique index was, and its successor `idx_book_details_isbn` still is, *partial* (`WHERE isbn IS NOT NULL`) — always check the migration file directly for CHECK/index clauses; a plan.md copy can omit nuances.

**Pass condition:** zero uncovered pairs, each covered pair citing its guard line and test. As of this refresh, that condition holds for the table above — the next audit should be run against any *new* route or schema change, not assumed to still hold indefinitely.

## 2. Money-arithmetic proof

**When:** touching `lib/money.ts` or any monetary I/O.

**Argument structure (why the current code is right):** floats are out (`0.1 + 0.2 === 0.30000000000000004`); `usdToCents` never does float math — it splits the string, takes 2 cent digits + 1 rounding digit, rounds half-up. Worked example derived by reading `lib/money.ts` (algorithm-traced, NOT a test fixture): `"9.999"` → frac3 `999` → 99 cents + roundDigit 9 → **1000**. The actual fixtures in `lib/__tests__/money.test.ts` are `"1.005"` → 101 and `"0.004"` → 0; bounds throw at negative and `> 100_000_000`.

**Round-trip property (verified 2026-07-02):** `usdToCents(centsToUSD(n)) === n` for all integer cents in range (centsToUSD emits canonical `d.cc`). The reverse normalizes, not identity: `centsToUSD(usdToCents("1.5")) === "1.50"`.

**Extension obligation:** any change must keep the no-float invariant, extend the edge-case table (third-digit rounding, bounds, empty/garbage input), and re-prove the round-trip. A generative property test is a CANDIDATE improvement, not current practice.

## 3. State-machine analysis

**When:** any proposed change to statuses or transitions (which is spec-gated — FR10, `resale-inventory-change-control`).

**Method:** write the adjacency map from `lib/transitions.ts`; prove terminality (empty set = no escape); enumerate reachability; assert counts.

**Worked example (verified):** out-degrees Unlisted 3, Listed 5, Sale Pending 2, Sold/Removed/Donated/Discarded 0 — and `tests/integration.test.ts` ("ALLOWED_TRANSITIONS set sizes") asserts exactly these numbers, so any edge change breaks a test by construction. Reachability from Unlisted: Listed (direct), Sale Pending (via Listed), Sold (only via Listed→Sale Pending — no shortcut, which is the AC3 dispute SR-6), Donated/Discarded (from Unlisted or Listed), Removed (only from Listed). No orphan states.

**Invariant to preserve:** test count assertions must equal map sizes — update both in one change or the suite catches you (good).

## 4. Predict-then-observe protocol

**When:** every experiment, probe, or reproduction. No exceptions — retrofitted expectations are how eyeballing sneaks back in.

**Protocol:** before running anything, write down: the exact command, the predicted status code, the predicted body/rows, and what result would falsify your mechanism. Then run. Then compare verbatim.

**Worked example (2026-07-02):** prediction from reading `app/api/import/route.ts` — "a 3-row CSV with a duplicated ISBN will return 500 and import zero rows, because the unique index throws inside the single `insertAll` transaction." Observed: `HTTP 500 {"error":"Internal server error"}`, follow-up GET showed 0 of 3 titles. Prediction matched in both number and mechanism — that match is what licensed the root-cause claim in D2.

**Template:**
```
HYPOTHESIS: <mechanism>
COMMAND: <exact command>
PREDICT: HTTP <code>, body <shape>, DB delta <rows>
FALSIFIED IF: <specific different observation>
OBSERVED: <verbatim>
VERDICT: supported / falsified / partial (explain every deviation)
```

## 5. One-mechanism rule + adversarial refutation

**Rule:** a proposed root cause must explain ALL observations — including the negatives (things that did NOT happen).

**Worked example — "why did 139 green tests miss two live defects?"** The mechanism must explain the green, not just the bugs. Verified explanation (2026-07-02, from reading `tests/integration.test.ts`): (a) the HTTP suite that would exercise route validation is `describe.skip`; (b) the DB-integration tests insert rows via direct SQL that already satisfies every CHECK (e.g., the helper inserts `status:'Listed'` together with `listing_price: 3000`), so no CHECK ever fires; (c) unit transition tests validate the transition *map*, and the listing-price rule is not in the map — it lives only in SQL. One mechanism, three clauses, explains both the defects and the green suite. A mechanism that explained only the failures would be rejected.

**Refutation practice:** before adopting a root cause, assign a second session/agent one job: break the mechanism (find an observation it cannot explain, or an alternative mechanism fitting equally well). And treat a *silent* zero-findings review as a re-run signal, not a pass — this project's spec review had exactly that failure: the Implementation Realist agent died producing nothing (SR-5), and the unreviewed angle (implementation-vs-schema mismatch) is precisely where D1/D2 later surfaced.

## 6. Idea lifecycle

```
proposal → spec gate (resale-inventory-change-control)
        → experiment with pre-registered predictions (method 4)
        → adopt: spec + code + tests land together
        → or retire: dated entry in resale-inventory-failure-archaeology (rejected register)
```

Nothing skips the gate by being "just an experiment" — experiments run on scratch copies; only adopted changes touch the repo. Where good ideas have actually come from here, on the record: adversarial spec review (SR-1, SR-2, SR-3: the gross_profit removal, junction table, WAL) and live probing with predictions (D1, D2). Zero came from eyeballing output.

## When NOT to use this skill

- Executing the defect fix → `resale-inventory-constraint-leak-campaign` (it consumes method 1's output).
- What evidence a change class needs procedurally → `resale-inventory-validation-and-qa` / `resale-inventory-change-control`.
- Triage of a live failure → `resale-inventory-debugging-playbook`.
- Historical entries themselves → `resale-inventory-failure-archaeology`.

## Provenance and maintenance

Authored 2026-07-02, content-refreshed 2026-07-12 to record that the constraint-leak campaign referenced throughout this file landed (D1-D4 all FIXED 2026-07-03) and that the schema/routes it was run against (`books`/`app/api/books/**`) were later rebuilt to `items`/`app/api/items/**` by migration `003_multi_category.sql`. Original verification (2026-07-02): full constraint enumeration against `data/migrations/001_init.sql` (including the partial-index nuance); money examples against `lib/money.ts` + its tests; set-size assertions in `tests/integration.test.ts`; the tests-green mechanism by reading the DB-integration helpers; D2 prediction transcript from the original live probe.

Re-verify:
- Audit table inputs: `cat data/migrations/*.sql` (re-run method 1 after ANY schema/route change — the table above goes stale the moment a new route or rule lands uncovered).
- Set sizes: `grep -n "set sizes" -A 8 tests/integration.test.ts`.
- Rounding fixtures: `grep -n '1\.005\|0\.004' lib/__tests__/money.test.ts` (the "9.999" example is algorithm-derived, not a test fixture — trace it against `lib/money.ts` directly).
- D1-D4 status: `grep -n "^| D[1-4] " .claude/skills/resale-inventory-failure-archaeology/SKILL.md` (expect all FIXED; if any regressed, that's the next audit's finding).
