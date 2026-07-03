---
name: book-seller-change-control
description: Governs how changes are made to the book-seller repo — spec-first authority order, change classification gates, non-negotiable rules, schema-migration protocol, and git/commit policy. Load before editing any code, spec, or schema in book-seller; when asked "can I change X", "how do I add a status/condition/column", "should I update requirements.md first", "can I commit this", or before any behavior-changing, schema, or security-touching edit.
---

# book-seller Change Control

Runbook for making any change to `/Users/prestonbernstein/dev/book-seller` — a local-first used-book inventory app (Next.js 15 App Router + better-sqlite3, sole operator, no CI, no lint, zero git commits). This skill defines WHO decides, WHAT order changes happen in, and WHICH rules are never broken. It does not teach the architecture (see `book-seller-architecture-contract`) or how to debug (see `book-seller-debugging-playbook`).

**Terms used once, then assumed:**
- **Spec folder** = `docs/book-inventory-management/` — `requirements.md` (22 functional requirements "FRs", 11 acceptance criteria "ACs"), `plan.md` (schema + API contract + security section), `steps.md`, `TASKS.md` (execution record, 17/17 done 2026-07-01), `challenge-notes.md` (adversarial review record).
- **The DB** = `data/inventory.db` — the operator's real, live inventory. Not a fixture. Not recreatable.
- **Constraint leak** = a DB CHECK constraint violation surfacing as HTTP 500 instead of a validated 422 (the current live defect cluster — see `book-seller-constraint-leak-campaign`).

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

There is no CI, no PR pipeline, no lint. "Merge-equivalent" here means: the evidence below exists before you call the change done. HTTP-level verification means a GET-only probe, the safe-test procedure from `book-seller-validation-and-qa`, or — when the behavior under test is itself mutating — a gated mutating probe under a campaign-style protocol (operator backup first, `CAMPAIGN-PROBE`-tagged rows, verified cleanup; the reference protocol is `book-seller-constraint-leak-campaign`). Never ad-hoc mutating requests against the live DB, and **never a raw `npx vitest run`** (see non-negotiable (e)).

| Class | Examples | Required gate before done |
|---|---|---|
| Docs-only | Fix typo in `plan.md`, clarify FR wording | None beyond the AC3 exception above; note material spec edits in `TASKS.md` |
| Non-behavioral refactor | Dedupe `VALID_CONDITIONS`, extract helper, rename internal fn | `npm run build` green (13 routes as of 2026-07-02); safe-test procedure from `book-seller-validation-and-qa`; no API response byte should change |
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
| d | Never weaken or drop DB CHECK constraints to silence HTTP 500s | The CHECKs are the last line of data integrity; the 500s are a validation-layer gap, not a schema bug. Correct fix = validate before write, return 422 | Two verified constraint leaks (2026-07-02): status→Listed without `listing_price` → 500; CSV import with duplicate ISBN → 500 and zero rows imported. Fix campaign: `book-seller-constraint-leak-campaign` |
| e | Never run `npx vitest run` (or any full test run) without the safe procedure in `book-seller-validation-and-qa` | `tests/integration.test.ts` (~line 138) executes `DELETE FROM books/book_platforms/price_history` and `lib/db.ts` resolves the DB path from `process.cwd()` — a plain test run **wipes the operator's real inventory** | Verified 2026-07-02 |
| f | All SQL via better-sqlite3 prepared statements with `?` placeholders; never interpolate user input | SQL injection | `plan.md` Security section (added in adversarial review) |
| g | Never delete, recreate, or write to `data/inventory.db` (or its `-wal`/`-shm` files) outside the app itself | Sole copy of live inventory; no backup routine exists yet (plan.md Risk 6 is unimplemented) | ASSUMPTION (coordinator-approved): DB is sacred. Read-only inspection: `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "..."` — DB care and backups: `book-seller-run-and-operate` |
| h | All monetary I/O goes through `lib/money.ts` (integer cents, string arithmetic, half-up rounding, 100,000,000-cent cap) | One missed decimal↔cents conversion silently corrupts data | `plan.md` Risk 2; `lib/money.ts` verified 2026-07-02 |

## 4. Schema-change protocol

Current reality (verified by reading `lib/db.ts`, 2026-07-02): the module resolves `data/inventory.db` from `process.cwd()`, opens it, sets `journal_mode=WAL` and `foreign_keys=ON`, then runs **exactly one file** — `data/migrations/001_init.sql` — via `db.exec()` at module load. **There is no migration runner.** No version table, no file loop, nothing that would pick up a `002_*.sql`.

Consequences for any schema change:

1. **Write a new numbered migration file** in `data/migrations/` (e.g., `002_extend_condition_enum.sql`). Never edit `001_init.sql` — it uses `CREATE TABLE IF NOT EXISTS`, so edits silently do nothing against the existing DB while lying about the schema.
2. **CHECK/enum changes require the table-rebuild pattern** (`plan.md` Risk 7): SQLite cannot alter inline CHECK constraints. Create the new table, copy rows, drop the old table, rename — inside one transaction, with `foreign_keys` handled.
3. **Adding migration 002 requires extending `lib/db.ts`** to run it (either hardcode the second file or build a minimal versioned runner). That is itself a behavior-adjacent change to the boot path — classify it under section 2 and gate accordingly.
4. Migration files must be **idempotent or version-guarded** — `lib/db.ts` runs its migration SQL on every boot.
5. Before any migration touches the live DB: the owner takes a backup copy first (procedure in `book-seller-run-and-operate`). Sessions never migrate the live DB autonomously.
6. Update `plan.md` Data model to match the post-migration schema in the same change.

## 5. Git and commit policy

Verified 2026-07-02: the repo is on branch `main` with **zero commits** (`git log` fails with "does not have any commits yet"). Everything — 17 completed tasks, spec, code — is uncommitted working tree.

- Establishing the baseline commit is the **owner's decision**. Sessions must not `git init` workflows, commit, or push autonomously — not even "helpfully" snapshotting before a change.
- When the owner does commit: commits are **owner-attributed**. Do not add AI authorship attribution, co-author trailers, or generated-by lines.
- Until a baseline exists, your only safety nets are (a) not touching the DB and (b) the spec folder's `.bak` files. Act accordingly: small, verified edits.

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
    read book-seller-constraint-leak-campaign first — don't fix ad hoc
```

### Pre-"done" checklist (run before reporting complete)

```
[ ] Spec updated first and matches the shipped behavior (requirements.md → plan.md)
[ ] npm run build green (expect 13 routes; a different count is a finding, not noise)
[ ] Safe-test procedure from book-seller-validation-and-qa executed — NOT raw npx vitest run
[ ] For API behavior: verified at HTTP level, actual status code read from a real response
    (dev server may be on :3001 — port 3000 is often taken by an unrelated Flutter app and
    Next falls back silently; read the dev output; kill the server after)
[ ] TASKS.md updated with what changed and why
[ ] data/inventory.db untouched (mtime check if paranoid); no commits made
[ ] Duplicated constants kept in sync if touched (VALID_CONDITIONS ×3 TS files + migration
    CHECK; ISBN_PATTERN ×2; DATE_RE ×3 — dedupe plan lives in book-seller-config-and-constants)
```

## 7. When NOT to use this skill

- **Understanding the design, invariants, or why the system is shaped this way** → `book-seller-architecture-contract`
- **A symptom is in front of you and you need triage** → `book-seller-debugging-playbook`
- **History of a specific past defect** → `book-seller-failure-archaeology`
- **Fixing the HTTP-500 constraint-leak cluster** (the current hardest live problem) → `book-seller-constraint-leak-campaign` (this skill only tells you the gates around that work)
- **How to test safely / what evidence counts** → `book-seller-validation-and-qa`
- **Running the app, DB backups, operational care** → `book-seller-run-and-operate`
- **Build, environment, Node/Next specifics** → `book-seller-build-and-env`
- **Where a constant lives / config values** → `book-seller-config-and-constants`
- **Writing docs or spec-file templates** → `book-seller-docs-and-writing`
- **Book-domain questions** (condition grades, platforms) → `bookselling-domain-reference`
- **Diagnostic scripts and tooling** → `book-seller-diagnostics-and-tooling`

Use this skill only when the question is "am I allowed to make this change, in what order, and what proves it's done."

## Provenance and maintenance

Authored 2026-07-02 from direct inspection of the repo (requirements.md, plan.md, TASKS.md, challenge-notes.md, lib/db.ts, lib/transitions.ts, lib/money.ts, package.json) plus coordinator-verified facts dated 2026-07-02. Items labeled ASSUMPTION are coordinator-approved, not repo-verified.

Re-verify volatile facts before relying on them:

- Zero git commits: `cd /Users/prestonbernstein/dev/book-seller && git log --oneline | head -1` (expect "does not have any commits yet")
- Single-migration boot path: `grep -n "001_init" /Users/prestonbernstein/dev/book-seller/lib/db.ts` (expect one hardcoded file, no runner loop)
- Migration count: `ls /Users/prestonbernstein/dev/book-seller/data/migrations/` (expect only `001_init.sql`)
- Test-suite DB-wipe trap still present: `grep -n "DELETE FROM" /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts` (any hit = trap live; do NOT run the suite to check)
- No CSRF middleware yet: `ls /Users/prestonbernstein/dev/book-seller/middleware.ts` (expect "No such file")
- AC3 contradiction still open: `grep -n "AC3" /Users/prestonbernstein/dev/book-seller/docs/book-inventory-management/challenge-notes.md` (open question section)
- Build route count: `npm run build` in repo root (expect success, 13 routes; safe, non-mutating)
- Transition map unchanged: `grep -n "Sale Pending" /Users/prestonbernstein/dev/book-seller/lib/transitions.ts` (Listed→Sold must NOT appear as allowed)
