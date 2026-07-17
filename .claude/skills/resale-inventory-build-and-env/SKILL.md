---
name: resale-inventory-build-and-env
description: Build and environment setup runbook for the resale-inventory repo (formerly resale-inventory; Next.js 15 + better-sqlite3 local-first inventory app). Use when asked to "set up" the project, "install" dependencies, "clone" onto a "fresh machine", run "npm ci", fix a "build fails" error, resolve "node version" / native-module ABI problems (ERR_DLOPEN), or do a clean rebuild. Ends when `npm run build` is green — running/operating and testing are sibling skills.
---

# resale-inventory — Build and Environment

Scope: get from a bare checkout to a green `npm run build` on this machine. Nothing more.
When the build is green, hand off to `resale-inventory-run-and-operate` (running the app, DB care)
or `resale-inventory-validation-and-qa` (testing).

Repo root (always run commands from here): `/Users/prestonbernstein/dev/resale-inventory`

---

## CRITICAL SAFETY WARNINGS — read before touching anything

1. **`npm test` / `npx vitest run` / `npm run test:coverage` are SAFE BY DEFAULT now —
   this used to not be true.** `vitest.config.ts` sets `BOOKSELLER_DB_PATH` and
   `BOOKSELLER_PHOTOS_PATH` to scratch paths under `.vitest-scratch/` via `test.env`, so
   `lib/db.ts` / `lib/photos.ts` never touch the real `data/inventory.db` / `data/photos/`
   during a normal `vitest run`. `tests/integration.test.ts`'s `beforeEach` (~line 137-141)
   still does `DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM
   item_platforms; DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM
   items;` on every DB-integration test — but against the scratch file, not the real one.
   `npm run test:e2e` is likewise safe via `playwright.config.ts` (`.playwright-scratch/`).
   **Do not remove or override those env vars in either config** — that is the entire
   safety mechanism. History of how this trap was closed: `T1` in
   `resale-inventory-failure-archaeology`.

2. **`npm run build`, `npm run dev`, and `npm start` DO touch the real database — this is
   the thing to be careful with now, not vitest.** Every import of `lib/db.ts` (build, dev
   server, prod start, any ad-hoc script run from the repo root) opens `data/inventory.db`
   and applies any pending versioned migration (gated by `PRAGMA user_version`, see §3).
   This is expected/by-design and never deletes rows, but it is **not** purely additive:
   `data/migrations/003_multi_category.sql` RENAMES the legacy `books`/`book_platforms`
   tables to `books_archived`/`book_platforms_archived` and rebuilds `price_history` —
   a real, one-way schema change, not a no-op `CREATE ... IF NOT EXISTS`. It only runs
   once (idempotent thereafter via `user_version`), but do not treat "the build touches
   the DB" as harmless boilerplate — read §3 before assuming it can't change anything.

3. **NEVER modify, delete, or recreate `data/inventory.db`, `data/inventory.db-wal`,
   `data/inventory.db-shm`, or `data/photos/`.** This is the live inventory (and its
   uploaded item photos) — treated as sacred by coordinator-approved rule, even though in
   practice the DB currently holds only a single legacy "Test Book" fixture row (now
   migrated into `items`/`book_details`, category `book`) and no real seller inventory has
   ever been entered. If you must inspect the DB, open read-only:
   ```sh
   sqlite3 "file:/Users/prestonbernstein/dev/resale-inventory/data/inventory.db?mode=ro"
   ```

4. **cwd trap:** importing `lib/db.ts` from the wrong working directory silently creates a
   stray empty `data/` dir + DB wherever you stand. Always `cd` to the repo root first.
   Details in "First-run behavior" below.

---

## 1. Prerequisites

There is **no `engines` field** in `package.json` — nothing enforces a Node version.
Treat the versions below as the dated known-good baseline, not a constraint.

| Tool | Verified version (2026-07-02) | Check command | Notes |
|---|---|---|---|
| Node.js | v24.16.0 | `node --version` | No `engines` field; v24.16.0 is a **verified-working dated fact**, not a requirement. After any Node **major** switch, see the ABI trap in §4. |
| npm | 11.13.0 | `npm --version` | `package-lock.json` present (lockfileVersion 3) — use `npm ci`, not `npm install`. |
| sqlite3 CLI | 3.51.0 | `sqlite3 --version` | Optional for build. Used by ops/diagnostics skills for read-only DB inspection. |
| Xcode Command Line Tools | any recent | `xcode-select -p` (prints a path if installed) | **Only needed if the better-sqlite3 prebuilt binary is missing** and the install script falls back to a node-gyp source compile. |

Platform verified: macOS (darwin, Apple Silicon / arm64).

---

## 2. From-scratch setup runbook

### Step 1 — obtain the repo and cd into it

```sh
cd /Users/prestonbernstein/dev/resale-inventory
```

(On a truly fresh machine: clone/copy the repo there first. The repo now has real commit
history on `main` — `git clone` works. This was **not** always true: it started with zero
commits and gained history partway through; if you see a skill or note elsewhere claiming
"zero commits", it's stale — re-verify with `git log --oneline | head -1`.)

Everything below assumes you are at the repo root. Do not run npm/node from anywhere else
(cwd trap, §3).

### Step 2 — install dependencies with `npm ci`

```sh
npm ci
```

**Why `npm ci` and not `npm install`:** `package-lock.json` is authoritative. `npm ci`
installs exactly the locked dependency tree and fails loudly if `package.json` and the
lockfile disagree; `npm install` may silently rewrite the lockfile. Two caveats:

- `npm ci` **deletes `node_modules/` first**, every time. Do not run it casually on a
  machine that already has a working install — it is a from-scratch operation.
- If `node_modules/` already exists and you just want to confirm it is in sync, use the
  cheap check instead:

  ```sh
  npm ls --depth=0
  ```

  Expected (re-verified 2026-07-12): a clean tree with no `invalid` / `missing` markers,
  including `better-sqlite3@12.11.1`, `next@15.5.19`, `react@19.1.0`, `react-dom@19.1.0`,
  `papaparse@5.5.4`, `uuid@14.0.1`, `tailwindcss@4.3.2`, `typescript@5.9.3`,
  `vitest@4.1.10`, `@vitejs/plugin-react@6.0.3`. Also present now (post multi-category
  migration and QA hardening): `@playwright/test`, `@stryker-mutator/core` +
  `@stryker-mutator/vitest-runner`, `fallow`, `jsdom`, `@testing-library/*` — see §"Known
  traps" and `resale-inventory-validation-and-qa` for what runs them.

**Native module note (better-sqlite3):** `better-sqlite3` has an install script
(`hasInstallScript: true` in the lockfile). It first tries to fetch a prebuilt binary;
if none matches your platform/Node it compiles from source with node-gyp (this is where
Xcode CLT is needed). Either way the binary ends up at:

```
node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

Verified state on this machine (2026-07-02): **no `prebuilds/` directory**; the binary in
use is `build/Release/better_sqlite3.node`, a Mach-O 64-bit arm64 bundle. Verify with:

```sh
file node_modules/better-sqlite3/build/Release/better_sqlite3.node
# → Mach-O 64-bit bundle arm64
```

### Step 3 — build

```sh
npm run build
```

This runs `next build --turbopack` (the `--turbopack` flag is in the script; do not add it
again). Expected output (captured on a real run, 2026-07-12, against an already-migrated
DB — see the note on first-ever-run below):

```
   ▲ Next.js 15.5.19 (Turbopack)

   Creating an optimized production build ...
 ✓ Finished writing to disk in ~200ms
 ✓ Compiled successfully in ~1s
   Linting and checking validity of types ...
   (ESLint may print `no-non-null-assertion` warnings against test files — non-blocking)
   Collecting page data ...
Database initialized at: /Users/prestonbernstein/dev/resale-inventory/data/inventory.db
   (the line above repeats several times — one per worker that imports lib/db.ts; normal)
 ✓ Generating static pages (14/14)

Route (app)                              Size  First Load JS
┌ ○ /                                     0 B         119 kB
├ ○ /_not-found                           0 B         119 kB
├ ƒ /api/dashboard                        0 B            0 B
├ ƒ /api/export                           0 B            0 B
├ ƒ /api/import                           0 B            0 B
├ ƒ /api/isbn/[isbn]                      0 B            0 B
├ ƒ /api/items                            0 B            0 B
├ ƒ /api/items/[id]                       0 B            0 B
├ ƒ /api/items/[id]/photos                0 B            0 B
├ ƒ /api/items/[id]/photos/[photoId]      0 B            0 B
├ ƒ /api/items/[id]/status                0 B            0 B
├ ƒ /api/items/suggestions                0 B            0 B
├ ○ /dashboard                          950 B         120 kB
├ ○ /inventory                        8.17 kB         127 kB
├ ƒ /inventory/[id]                   10.5 kB         129 kB
├ ○ /inventory/new                    3.81 kB         123 kB
└ ○ /playbook                             0 B         119 kB

ƒ Middleware                          39.2 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

**17 routes total** (12 API + 5 pages, plus middleware). Sizes/chunk hashes will drift;
the route list is the signal. There is no `/api/books*` or `/books*` anymore — those were
deleted in the multi-category migration; everything now lives under `/api/items/*` and
`/inventory*` (see `resale-inventory-architecture-contract` for the full route/table map).

Yes — the build itself imports `lib/db.ts` and touches the real DB (it runs any pending
versioned migration and logs the `Database initialized at:` line, plus an `Applied
migration <file> (user_version → N)` line for each migration it actually runs). This is
expected, and once a DB is on the latest `user_version` it is a safe no-op — but the
**first** build/dev/start against a not-yet-migrated DB is not a mere additive init: see
CRITICAL SAFETY WARNING #2 above (`003_multi_category.sql` renames tables). This is also
why you must run the build **from the repo root** — from anywhere else it would create a
stray DB.

### Step 4 — verification checklist

- [ ] `npm ls --depth=0` — clean tree, no `invalid`/`missing`
- [ ] `npm run build` — exits 0, route table shows all 17 routes
- [ ] `file node_modules/better-sqlite3/build/Release/better_sqlite3.node` — matches your arch (arm64 here)
- [ ] No stray `data/` directories created outside the repo root (detection command in §3)
- [ ] Testing itself (running the suite, coverage, mutation, E2E) is safe-by-default now
      (see CRITICAL SAFETY WARNING #1) but is still out of scope here — the full procedure,
      thresholds, and commands live in `resale-inventory-validation-and-qa`.

Build green? You are done. Running the app is `resale-inventory-run-and-operate`.

---

## 3. First-run behavior of `lib/db.ts`

Any import of `lib/db.ts` (build, dev server, API route, script, test) executes this at
module load, in order (source: `/Users/prestonbernstein/dev/resale-inventory/lib/db.ts`):

1. Resolves DB path as `process.env.BOOKSELLER_DB_PATH ?? path.join(process.cwd(), 'data',
   'inventory.db')` — **env var first, then cwd, never repo root directly.** Tests and E2E
   set `BOOKSELLER_DB_PATH` (see CRITICAL SAFETY WARNING #1); an unset env var falls back
   to the historical cwd-based default, which is what build/dev/start use.
2. `fs.mkdirSync` on the `data/` dir (recursive — creates it if absent).
3. Opens the DB with better-sqlite3 (creates an empty DB file if absent).
4. Pragmas: `journal_mode = WAL`, `foreign_keys = ON` (WAL is why `-wal`/`-shm` siblings exist).
5. Runs a **versioned migration loop**, not a single hardcoded file: `VERSIONED_MIGRATIONS
   = [{version:1, file:'001_init.sql'}, {version:2, file:'002_price_history_nullable.sql'},
   {version:3, file:'003_multi_category.sql'}]`. It reads `PRAGMA user_version` and, for
   every migration whose `version` exceeds it, executes that file's SQL inside a
   `db.transaction()` and bumps `user_version` to match — so each migration runs at most
   once, in order, and a boot against an already-migrated DB is a no-op. Migration files
   are resolved from `path.join(process.cwd(), 'data', 'migrations', file)` — still
   cwd-based, so from the wrong cwd this **throws ENOENT** (after already creating the
   stray DB in steps 2–3).
6. Logs `` Applied migration ${file} (user_version → ${version}) `` for each migration it
   actually ran, then unconditionally logs `` Database initialized at: ${dbPath} `` — e.g.
   `Database initialized at: /Users/prestonbernstein/dev/resale-inventory/data/inventory.db`.
7. Fires off `runStartupBackup(db, dbPath)` (from `lib/backup.ts`) without awaiting it —
   snapshots `data/inventory.db` to `data/backups/inventory-YYYYMMDD.db` via SQLite's
   WAL-safe online-backup API, keeping the newest 7, and swallows its own errors so a
   backup failure never breaks boot.

**The cwd trap:** run any node/npm entrypoint that touches `lib/db.ts` from the wrong
directory and you get a stray empty `data/` dir + `inventory.db` wherever you were
standing. Check the logged path every time — if it is not
`/Users/prestonbernstein/dev/resale-inventory/data/inventory.db`, you created a stray.

Detection command (finds stray `data/inventory.db` files under home, excluding the real
one and noise dirs):

```sh
find ~ -maxdepth 4 -path "*/data/inventory.db" -not -path "*/dev/resale-inventory/*" -not -path "*/node_modules/*" 2>/dev/null
```

Expected output: nothing. Any hit is a stray — safe to delete **only after confirming it
is not the real DB** at `/Users/prestonbernstein/dev/resale-inventory/data/inventory.db`.

---

## 4. Known traps

| Trap | Symptom | Remedy / verify |
|---|---|---|
| Native module ABI after Node major switch | `ERR_DLOPEN_FAILED` / "was compiled against a different Node.js version" on any import of `lib/db.ts` (build, dev, everything) | `npm rebuild better-sqlite3` from the repo root, then verify: `node -e "require('better-sqlite3'); console.log('ok')"` → `ok` |
| Port 3000 squatter | An unrelated Flutter app usually holds port 3000; `next dev` **silently falls back to 3001**. Probing `http://localhost:3000` hits the wrong app with no error. | Read the dev server's startup output for the real port (`- Local: http://localhost:3001`). Never assume 3000. Kill any dev server you started when done. (Operating the dev server is `resale-inventory-run-and-operate`.) |
| Turbopack flag | Wondering why builds differ from stock Next docs | Both scripts carry it: `dev` = `next dev --turbopack -H 127.0.0.1`, `build` = `next build --turbopack`. Do not add/remove the flag; it is the project baseline. Note `dev` also binds `127.0.0.1` explicitly now (was DR-4, fixed). |
| Assuming `npm test` is missing or unsafe | Old instinct to avoid it entirely | **Stale.** `package.json` now has a real `"test": "vitest run"` script (plus `test:watch`, `test:coverage`, `test:e2e`, `test:mutation`, `analyze`, `lint`, `typecheck`), and it's safe-by-default against the real DB (CRITICAL SAFETY WARNING #1). Full procedure, coverage thresholds, and mutation/E2E details: `resale-inventory-validation-and-qa`. |
| No `.env*` files | Looking for secrets/config to copy on a fresh machine | Still absent **by design** as of 2026-07-12 (re-verified) — this app has no secrets. `.gitignore` excludes `.env*` defensively, but none exist and none are needed. Do not create one. App config lives in code: `resale-inventory-config-and-constants`. |
| `npm ci` surprise | node_modules vanished mid-debug | `npm ci` always deletes `node_modules/` first. Use `npm ls --depth=0` for cheap sync checks instead. |

---

## 5. Clean-rebuild recipe

Safe to delete (all regenerable):

| Path | Regenerated by |
|---|---|
| `.next/` | `npm run build` (or `npm run dev`) |
| `tsconfig.tsbuildinfo` | next TypeScript check during build |
| `node_modules/` | `npm ci` |
| `coverage/` | `npm run test:coverage` |
| `.fallow/` | `npm run analyze` |
| `.vitest-scratch/`, `.playwright-scratch/` | next `npm test` / `npm run test:e2e` run (these are the scratch DB/photo dirs from CRITICAL SAFETY WARNING #1 — never confuse them with `data/`) |

```sh
cd /Users/prestonbernstein/dev/resale-inventory
rm -rf .next tsconfig.tsbuildinfo node_modules
npm ci
npm run build   # expect the 17-route table from §2
```

**NEVER safe to delete — coordinator-approved rule:**

- `data/inventory.db`, `data/inventory.db-wal`, `data/inventory.db-shm` — the live
  inventory. The `-wal` file can hold unmerged writes; deleting it alone loses data.
- `data/photos/` — uploaded item photos (only relevant for `clothing` items today; books
  never get photos per FR14). Same "real, not test data" status as the DB.
- `data/backups/` — backups (`inventory-YYYYMMDD.db` snapshots, newest 7 kept, written by
  `lib/backup.ts`'s startup routine — see §3 step 7).
- `data/migrations/` — required by `lib/db.ts` at every startup (ENOENT without it).

Rule of thumb: **nothing under `data/` is ever cleanup material.** `.gitignore` excludes
`.env*`, `data/inventory.db`, `*.db`/`*.db-shm`/`*.db-wal`, `/data/backups/*` (except
`.gitkeep`), and `/data/photos/*` (except `.gitkeep`) — git will never protect these files,
so there is no recovery via `git checkout` if one is deleted. (The repo does have commit
history now — 20+ commits on `main` — but none of it includes these gitignored paths.)

Note: since the build imports `lib/db.ts`, a "clean rebuild" still opens the real DB. If it
is already on the latest `user_version` this is a safe no-op; if it is not (e.g. a fresh
clone whose DB predates a schema change), the build will apply whatever migrations are
pending — see CRITICAL SAFETY WARNING #2. Either way it never deletes rows.

---

## 6. When NOT to use this skill

- **Running or operating the app** (dev server lifecycle, prod start, DB care, backups) →
  `resale-inventory-run-and-operate`. This skill ends when `npm run build` is green.
- **Running tests** (unit/component via vitest, E2E via Playwright, mutation via Stryker,
  coverage thresholds) → `resale-inventory-validation-and-qa`.
- **Diagnosing app bugs / runtime misbehavior** → `resale-inventory-debugging-playbook`,
  `resale-inventory-diagnostics-and-tooling`.
- **Understanding architecture, routes, data model** → `resale-inventory-architecture-contract`.
- **Changing config values or constants** → `resale-inventory-config-and-constants` (and
  `resale-inventory-change-control` for any change process).
- **Past incidents / why things are the way they are** → `resale-inventory-failure-archaeology`.
- **Domain questions about bookselling itself** → `bookselling-domain-reference`.
- **Docs/writing, research, analysis** → `resale-inventory-docs-and-writing`,
  `resale-inventory-research-frontier`, `resale-inventory-analysis-and-methodology`.

---

## Provenance and maintenance

Authored 2026-07-02 by direct verification on the target machine (macOS arm64, Node
v24.16.0, npm 11.13.0, sqlite3 CLI 3.51.0): read `package.json`, `package-lock.json`,
`tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `.gitignore`,
`lib/db.ts`; ran `npm run build` (route table pasted verbatim) and `npm ls --depth=0`.
The vitest DB-wipe hazard was verified 2026-07-02 by reading `tests/integration.test.ts`
— NOT by running it.

**Re-verified and substantially rewritten 2026-07-12**, after the multi-category
(books+clothing) migration, a QA-hardening pass, and a UX/dark-mode pass had all landed:
re-read `package.json`, `lib/db.ts`, `lib/photos.ts`, `lib/backup.ts`, `vitest.config.ts`,
`playwright.config.ts`, `middleware.ts`, `data/migrations/*.sql`; re-ran `npm ls --depth=0`,
`npm run build` (new 17-route table pasted above), and `npx vitest run` with
`BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH` pointed at a scratch location (612 passed, 18
skipped — matches `resale-inventory-failure-archaeology`'s baseline) to confirm the real DB
is untouched by a normal test run. Toolchain versions (Node/npm/sqlite3 CLI) re-checked and
still match the 2026-07-02 baseline. **Note:** the `npm run build` run performed during this
audit applied the pending `003_multi_category.sql` migration to the real
`data/inventory.db` (it was sitting at `user_version = 0`, unmigrated, since before this
pass) — the single "Test Book" fixture row survived intact (now under `items`/
`book_details`, category `book`), and the original `books`/`book_platforms` tables were
preserved as `books_archived`/`book_platforms_archived` per the migration's own rollback
design. No data was lost, but this is exactly the CRITICAL SAFETY WARNING #2 behavior in
action — a reminder that "just run the build" is not a no-op action on a not-yet-migrated
DB.

Versions WILL drift. One-line re-verification commands:

```sh
node --version && npm --version && sqlite3 --version            # toolchain baseline
cd /Users/prestonbernstein/dev/resale-inventory && npm ls --depth=0  # dep tree vs lockfile
cd /Users/prestonbernstein/dev/resale-inventory && npm run build     # route table still 17 routes? (touches the real DB — see CRITICAL SAFETY WARNING #2)
file /Users/prestonbernstein/dev/resale-inventory/node_modules/better-sqlite3/build/Release/better_sqlite3.node  # native binary arch
grep -n "process.cwd()\|BOOKSELLER_DB_PATH" /Users/prestonbernstein/dev/resale-inventory/lib/db.ts  # cwd trap + env override still present?
sed -n '135,145p' /Users/prestonbernstein/dev/resale-inventory/tests/integration.test.ts  # wipe-on-scratch-DB behavior still present?
grep -n "BOOKSELLER_DB_PATH\|BOOKSELLER_PHOTOS_PATH" /Users/prestonbernstein/dev/resale-inventory/vitest.config.ts /Users/prestonbernstein/dev/resale-inventory/playwright.config.ts  # safe-by-default wiring still present?
sqlite3 "file:/Users/prestonbernstein/dev/resale-inventory/data/inventory.db?mode=ro" "PRAGMA user_version;"  # read-only DB schema-version check, never write
```

If any re-verification diverges from this file, update the affected section and refresh
the date above.
