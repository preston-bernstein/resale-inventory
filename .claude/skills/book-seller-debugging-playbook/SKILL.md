---
name: book-seller-debugging-playbook
description: Triage runbook for the book-seller app. Use when debugging a 500 error or {"error":"Internal server error"}, import fails or imports 0 rows, data missing / all inventory rows suddenly gone, tests pass but API broken, "database is locked", curl returns HTML instead of JSON, wrong port (3000 vs 3001), zsh "no matches found" on route paths, ISBN lookup 404 for a known-good ISBN, or the server won't start with a better-sqlite3 native module error. Maps each symptom to one discriminating check.
---

# Book-Seller Debugging Playbook

Symptom-first triage for `/Users/prestonbernstein/dev/book-seller` — a local-first used-book inventory app (Next.js 15.5.19 App Router + better-sqlite3, SQLite DB at `data/inventory.db`). This skill gets you from "something is wrong" to "I know which failure this is and which skill owns the fix" in one or two commands. It does **not** contain fixes — it routes to sibling skills that do.

**Terms used once, defined here:**
- **Discriminating check** — a single command whose output splits the hypothesis space (tells you which failure you have, not just that one exists).
- **DB CHECK constraint** — a rule enforced inside SQLite itself (see `data/migrations/001_init.sql`). When application code skips validation, the CHECK throws at INSERT/UPDATE time, and every API route's catch-all converts that into an opaque HTTP 500. This "constraint leak" is the app's signature failure mode.
- **WAL** — SQLite write-ahead-log mode (enabled in `lib/db.ts`). Means the live DB is three files: `inventory.db`, `-wal`, `-shm`. Never touch any of them by hand.

## Hard safety rules (read before running anything)

1. **Never run `npx vitest run` (or any vitest invocation) from the repo root.** `tests/integration.test.ts` line 138 executes `DELETE FROM price_history; DELETE FROM book_platforms; DELETE FROM books;` against the **real** `data/inventory.db`, because `lib/db.ts` line 5 resolves the DB path from `process.cwd()`. Verified 2026-07-02: a past test run demonstrably wiped whatever the DB held (only test residue remains; no evidence real business data existed yet — but the trap is armed for the day it does). Safe test procedure lives in **book-seller-validation-and-qa**.
2. **Never modify/delete/recreate `data/inventory.db`, `-wal`, or `-shm`.** Inspect read-only only, via the URI pattern in the toolkit section below.
3. **No mutating HTTP requests (POST/PATCH/DELETE) during triage.** GET-only probes. Reproductions of the known 500 defects are mutating — they are gated behind **book-seller-constraint-leak-campaign**.
4. If you start `npm run dev`, kill it when done, and read its stdout for the real port (see port trap below).

## When NOT to use this skill

- **You already know the failure and want the fix** for the status-transition 500 or the import 500 → go straight to **book-seller-constraint-leak-campaign**.
- **You're changing behavior** (route code, validation, schema) → **book-seller-change-control** first; `docs/book-inventory-management/` is the change-control authority.
- **Build/install/environment setup problems** (fresh clone, node version, npm install) → **book-seller-build-and-env**.
- **Routine operations** — starting/stopping the app, DB care, backups, port management → **book-seller-run-and-operate**.
- **Writing or running tests safely** → **book-seller-validation-and-qa**.
- **You want the full defect history with evidence transcripts** → **book-seller-failure-archaeology**.
- **Understanding the architecture or domain**, not a live failure → **book-seller-architecture-contract** / **bookselling-domain-reference**.

## Symptom → Triage table

| Symptom | First discriminating check (one command) | Likely cause | Go to |
|---|---|---|---|
| Opaque 500 on status change: `{"error":"Internal server error."}` from `POST /api/books/<id>/status` | `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT status, listing_price FROM books WHERE id='<id>';"` | Transition to `Listed`/`Sale Pending` with `listing_price` NULL → DB CHECK throws inside route catch-all (Defect 1, verified 2026-07-02) | book-seller-constraint-leak-campaign |
| Import returns 500, `{"error":"Internal server error"}`, 0 rows imported | `sqlite3 "file:...inventory.db?mode=ro" "SELECT isbn, COUNT(*) FROM books GROUP BY isbn HAVING COUNT(*)>1;"` then check the CSV for duplicate/pre-existing ISBNs | Duplicate ISBN hits unique index inside the single `insertAll` transaction — whole batch aborts, valid rows lost too (Defect 2, verified 2026-07-02) | book-seller-constraint-leak-campaign |
| curl gets HTML instead of JSON | `curl -s http://localhost:3000/api/dashboard \| head -c 100` — starts `<!DOCTYPE html>` → wrong app | Port 3000 held by an unrelated Flutter app (via Docker); Next silently fell back to 3001 | this skill (port trap story below), ops detail in book-seller-run-and-operate |
| ALL inventory rows suddenly gone | `sqlite3 "file:...inventory.db?mode=ro" "SELECT title, created_at FROM books;"` — residue rows titled `Test Book` = someone ran vitest | `npx vitest run` wiped the live DB (see safety rule 1) | book-seller-run-and-operate (recovery only from backups, if any exist — `data/backups/` was empty on 2026-07-02, git has zero commits) |
| `database is locked` / `SQLITE_BUSY` | `lsof /Users/prestonbernstein/dev/book-seller/data/inventory.db` — see who holds it | An RW `sqlite3` shell (or second process) open while the dev server runs | Close the RW shell; always inspect with `?mode=ro` URI (toolkit below) |
| zsh: `no matches found: app/api/books/[id]/route.ts` | Re-run with the path quoted: `cat "app/api/books/[id]/route.ts"` | zsh globs `[...]` — bracketed Next.js route paths must be quoted | this skill (no escalation needed) |
| ISBN lookup 404 for a known-good ISBN | `curl -s -m 5 -o /dev/null -w "%{http_code}\n" "https://openlibrary.org/api/books?bibkeys=ISBN:9780306406157&format=json&jscmd=data"` | Open Library down/slow: `lib/isbn.ts` returns null on ANY error incl. 3s timeout, and the route maps null → 404 (not 503). Degraded manual entry is the designed fallback (FR3/AC11) | bookselling-domain-reference; if you want timeout→503, that's a behavior change → book-seller-change-control |
| Tests green but API misbehaves | `grep -n "describe.skip" /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts` | 15 tests are skipped (whole HTTP suite + 1 network test); the unit layer cannot catch DB CHECK leaks — Defects 1 and 2 shipped with 139 passing tests | book-seller-validation-and-qa |
| Server won't start: `ERR_DLOPEN` / ABI / NODE_MODULE_VERSION error mentioning better_sqlite3.node | `ls /Users/prestonbernstein/dev/book-seller/node_modules/better-sqlite3/build/Release/` — native binary present? | better-sqlite3 is a native module (binary verified at that path); a Node major upgrade breaks the ABI. Standard remedy: `npm rebuild better-sqlite3` (general knowledge, not repo-verified) | book-seller-build-and-env |
| Stray empty `data/` dir appears somewhere unexpected | `grep -n "process.cwd" /Users/prestonbernstein/dev/book-seller/lib/db.ts` | `lib/db.ts` builds the DB path from `process.cwd()` and `mkdirSync`s it — running any code that imports it from another cwd creates (or worse, uses) a fresh empty DB there | book-seller-architecture-contract |

## Top traps — what actually happened, and how to discriminate

### Trap 1: The opaque status-transition 500 (Defect 1 — verified live 2026-07-02)

**Story.** A book was created via `POST /api/books` (valid body → 201 with an id). Then `POST /api/books/<id>/status` with body `{"status":"Listed"}` — a perfectly legal transition per `lib/transitions.ts` (Unlisted→Listed is allowed) — returned **HTTP 500** with body exactly `{"error":"Internal server error."}`. The client had no way to know what was wrong.

**Root cause.** The route (`app/api/books/[id]/status/route.ts`) validates the transition graph but never checks the price precondition. The schema (`data/migrations/001_init.sql` line 24) has:

```sql
CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL)
```

The book had no `listing_price`, the UPDATE violated the CHECK, better-sqlite3 threw, and the route's catch-all (lines 116–119) turned it into a 500 instead of a 422.

**Discriminating check (read-only, safe):**

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT id, status, listing_price FROM books WHERE id='<the-id>';"
```

Expected when this is Defect 1: `status` is `Unlisted` (or `Sale Pending`) and `listing_price` is empty (NULL). Diagnosis confirmed — do not "fix" it ad hoc; the gated fix and reproduction protocol live in **book-seller-constraint-leak-campaign**. Do not reproduce casually: the reproduction is a mutating POST.

**Related SUSPECTED variant (unverified — do not verify by mutation):** `PATCH /api/books/<id>` with `{"listing_price": null}` on a `Listed` book. `app/api/books/[id]/route.ts` explicitly allows clearing to null (line 66–67), so the UPDATE should hit the same CHECK → same opaque 500. Treat as OPEN until the campaign skill verifies it under its protocol.

### Trap 2: Import 500 loses the whole batch (Defect 2 — verified live 2026-07-02)

**Story.** A 3-row CSV was POSTed to `/api/import`: rows 1 and 2 shared ISBN `9780306406157`, row 3 was valid with **no ISBN** (empty field → NULL, which the partial unique index permits). Result: **HTTP 500** `{"error":"Internal server error"}` and **0 rows imported** — the innocent row 3 was lost along with the duplicates. This violates FR22/AC9 (per-row error reporting).

**Root cause.** `app/api/import/route.ts` normalizes ISBNs only by stripping non-alphanumerics (line 137 — it does NOT do ISBN-10→13 conversion like `lib/isbn.ts` does, and does NOT check for duplicates within the file or against the DB). All valid rows go into one `db.transaction` (lines 159–165); the unique index `idx_books_isbn` throws mid-transaction, aborting everything, and the catch-all returns 500.

**Discriminating check (read-only, safe):** check the CSV for internal duplicates and collisions with existing rows.

```bash
# ISBNs already in the DB:
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT isbn FROM books WHERE isbn IS NOT NULL;"
# Duplicate ISBNs inside your CSV (column position may vary — check the header):
awk -F',' 'NR>1 {print $NF}' your-import.csv | sort | uniq -d
```

Any overlap or internal duplicate → this is Defect 2. Do not reproduce with a live POST — go to **book-seller-constraint-leak-campaign**.

### Trap 3: Port 3000 serves the wrong app (verified live 2026-07-02)

**Story.** With an unrelated Flutter web app holding port 3000 (served via Docker — `lsof` shows `com.docke` PID on :3000), `npm run dev` did not fail. It logged:

```
 ⚠ Port 3000 is in use by process 27675, using available port 3001 instead.
   - Local:        http://localhost:3001
```

Meanwhile `curl http://localhost:3000/api/dashboard` returned **HTTP 200** with HTML starting `<!DOCTYPE html>` and containing "flutter" — a silent wrong-target trap: the status code looks healthy, the body is a different app entirely.

**Discriminating check:**

```bash
curl -s http://localhost:3000/api/dashboard | head -c 30
```

Expected if trapped: `<!DOCTYPE html>` (Flutter). Expected if book-seller actually got :3000: JSON starting `{"held_count":`. Always read the dev-server stdout for the real port; never assume 3000.

### Trap 4: The vitest wipe (verified live 2026-07-02 — the DB is still carrying the scar)

**Story.** `npx vitest run` reports a reassuring "139 passed, 15 skipped" — and silently deletes every row from `books`, `book_platforms`, and `price_history` in the real `data/inventory.db`. As of 2026-07-02 the live DB contains exactly one row: a `Test Book` leftover from a past run, proving a wipe occurred. Whatever preceded that run is unrecoverable: `data/backups/` contains only `.gitkeep` and the git repo has zero commits (`git log` → "does not have any commits yet"). No evidence real business inventory existed before the wipe (the project is days old) — but once it does, this trap is catastrophic and there is still no net (see T1/DR-2 in **book-seller-failure-archaeology**).

**Discriminating check (is a missing-data incident a vitest wipe?):**

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT title, author, created_at FROM books ORDER BY created_at DESC LIMIT 5;"
```

Expected signature: few/zero rows, with residue titled `Test Book` / author `Test Author` (the fixtures in `tests/integration.test.ts` lines 147–148). Recovery and backup routine: **book-seller-run-and-operate**. Safe testing: **book-seller-validation-and-qa**.

### Trap 5: Green tests, broken API

**Story.** Defects 1 and 2 both existed while the full suite passed (139 passed, 15 skipped). The skipped 15 are the entire HTTP suite (`describe.skip`) plus one network test — exactly the layer that would exercise route catch-alls against real CHECK constraints. Passing unit tests for `lib/transitions.ts` prove the transition *graph*, not the *route's* handling of DB constraint violations.

**Discriminating check:**

```bash
grep -n "skip" /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts | head
```

If your bug is in request handling, status codes, or constraint interaction, assume tests are blind to it until **book-seller-validation-and-qa**'s HTTP-level procedure covers it.

## Safe evidence-gathering toolkit

All commands below are read-only / GET-only and verified against this repo on 2026-07-02.

**Read-only SQLite (the ONLY approved way to open the DB):**

```bash
sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" \
  "SELECT COUNT(*) FROM books; SELECT status, COUNT(*) FROM books GROUP BY status;"
```

Verified output shape (2026-07-02): `1` then `Listed|1`. The `?mode=ro` URI avoids taking a write lock, so it is safe while the dev server runs (a plain RW `sqlite3 data/inventory.db` shell is how you cause `SQLITE_BUSY` — don't).

**Port detection:**

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN; lsof -nP -iTCP:3001 -sTCP:LISTEN
```

Verified 2026-07-02: :3000 → `com.docke` (the Flutter app), :3001 → empty until book-seller's dev server is up. Alternatively grep the dev log: `grep -m1 "Local:" dev.log` → `- Local: http://localhost:3001`.

**Starting/stopping a probe server (only if not already running):**

```bash
cd /Users/prestonbernstein/dev/book-seller && nohup npm run dev > /tmp/bs-dev.log 2>&1 &
sleep 4 && grep -E "Port 3000|Local:" /tmp/bs-dev.log   # read the REAL port here
# ... probes ...
kill %1    # or kill <pid>; then verify: lsof -nP -iTCP:3001 -sTCP:LISTEN
```

**GET-only probes with expected shapes (verified live 2026-07-02, port 3001):**

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3001/api/dashboard
```

```json
{"held_count":1,"held_acquisition_cost":1000,
 "by_condition":{"Poor":0,"Acceptable":0,"Good":1,"Very Good":0,"Like New":0},
 "by_status":{"Unlisted":0,"Listed":1,"Sale Pending":0,"Sold":0,"Removed":0,"Donated":0,"Discarded":0}}
HTTP 200
```

```bash
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3001/api/books?limit=5"
# → {"items":[{ id, isbn, title, author, publisher, condition, acquisition_cost,
#    acquisition_date, status, listing_price, sale_price, sale_platform, sale_date,
#    created_at, updated_at, gross_profit, platforms:[...] }], "total":N, "page":0, "limit":5}  HTTP 200
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3001/api/books?limit=500"
# → {"error":"limit must be 1–200."}  HTTP 400   (verified — a handy known-good 4xx probe)
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3001/api/books/<id>"
# → book + price_history[]; 404 {"error":"Not found."} for unknown id
curl -s "http://localhost:3001/api/export" | head -2
# → CSV with header id,isbn,title,... (GET, read-only)
```

**Quoting bracketed route paths in zsh (always):**

```bash
cat "/Users/prestonbernstein/dev/book-seller/app/api/books/[id]/status/route.ts"
```

**Known drift to keep in mind while reading evidence** (details in book-seller-architecture-contract): no `middleware.ts`; no backup routine (`data/backups/` empty); `lib/types.ts` is literally `// stub`; `price_history.previous_price` is written as `0` when the previous price was NULL (`app/api/books/[id]/route.ts` line 113 `oldPrice ?? 0`) — so a `previous_price` of 0 in evidence may mean "was NULL", not "was free".

## Escalation rules

1. **Triage says the fix changes behavior** (status codes, validation, schema, route logic) → stop; open **book-seller-change-control**. `docs/book-inventory-management/` (requirements.md, plan.md, steps.md, TASKS.md, challenge-notes.md) is the change-control authority; no behavior change without it.
2. **Matches Defect 1 or Defect 2** (constraint-leak 500s above) → **book-seller-constraint-leak-campaign**. That skill owns the gated mutating reproduction protocol and the fix. This playbook only triages.
3. **Brand-new failure** (not in the table above) → record it in **book-seller-failure-archaeology** format (dated symptom, exact command + output transcript, root-cause hypothesis, verification status) before or alongside fixing. Then add a row to this playbook's triage table.
4. **Need scripts** (port-detect, api-smoke, db-integrity, constants-drift) → **book-seller-diagnostics-and-tooling**.

## Provenance and maintenance

Authored 2026-07-02 from direct source reading (`lib/db.ts`, `lib/transitions.ts`, `lib/isbn.ts`, all `app/api/**/route.ts`, `tests/integration.test.ts`, `data/migrations/001_init.sql`) plus live GET-only probes on port 3001 and read-only sqlite3 inspection the same day. Defects 1–2 and the vitest wipe are from the principal engineer's verified live transcripts of 2026-07-02 — do not re-run those mutating reproductions to "check"; use book-seller-constraint-leak-campaign's protocol. Items marked ASSUMPTION/OPEN/SUSPECTED are unverified.

One-line re-verification commands:

- CHECK constraint still present: `grep -n "listing_price IS NOT NULL" /Users/prestonbernstein/dev/book-seller/data/migrations/001_init.sql`
- vitest wipe still armed: `grep -n "DELETE FROM" /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts`
- DB path still cwd-relative: `grep -n "process.cwd" /Users/prestonbernstein/dev/book-seller/lib/db.ts`
- Import still single-transaction, no dup check: `grep -n "db.transaction" /Users/prestonbernstein/dev/book-seller/app/api/import/route.ts`
- Port 3000 still occupied: `lsof -nP -iTCP:3000 -sTCP:LISTEN`
- HTTP suite still skipped: `grep -n "describe.skip" /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts`
- Native binary present: `ls /Users/prestonbernstein/dev/book-seller/node_modules/better-sqlite3/build/Release/`
- DB reachable read-only: `sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro" "SELECT COUNT(*) FROM books;"`
