---
name: book-seller-build-and-env
description: Build and environment setup runbook for the book-seller repo (Next.js 15 + better-sqlite3 local-first inventory app). Use when asked to "set up" the project, "install" dependencies, "clone" onto a "fresh machine", run "npm ci", fix a "build fails" error, resolve "node version" / native-module ABI problems (ERR_DLOPEN), or do a clean rebuild. Ends when `npm run build` is green — running/operating and testing are sibling skills.
---

# book-seller — Build and Environment

Scope: get from a bare checkout to a green `npm run build` on this machine. Nothing more.
When the build is green, hand off to `book-seller-run-and-operate` (running the app, DB care)
or `book-seller-validation-and-qa` (testing).

Repo root (always run commands from here): `/Users/prestonbernstein/dev/book-seller`

---

## CRITICAL SAFETY WARNINGS — read before touching anything

1. **NEVER run `npx vitest run` (or `npm test`, or any vitest invocation) as a smoke test.**
   `tests/integration.test.ts` (~line 138) DELETEs all rows in the REAL production database
   `data/inventory.db`, because `lib/db.ts` resolves the DB path from `process.cwd()`.
   Verified 2026-07-02. There is a safe test procedure — it lives in
   **`book-seller-validation-and-qa`**. Route there. Do not improvise.

2. **NEVER modify, delete, or recreate `data/inventory.db`, `data/inventory.db-wal`, or
   `data/inventory.db-shm`.** This is the live inventory — treated as sacred by
   coordinator-approved rule. If you must inspect it, open read-only:
   ```sh
   sqlite3 "file:/Users/prestonbernstein/dev/book-seller/data/inventory.db?mode=ro"
   ```

3. **cwd trap:** importing `lib/db.ts` from the wrong working directory silently creates a
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
cd /Users/prestonbernstein/dev/book-seller
```

(On a truly fresh machine: clone/copy the repo there first. Note the repo currently has
**zero git commits** — obtaining it may mean copying the directory, not `git clone`.)

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

  Expected (2026-07-02): a clean tree with no `invalid` / `missing` markers, including
  `better-sqlite3@12.11.1`, `next@15.5.19`, `react@19.1.0`, `react-dom@19.1.0`,
  `papaparse@5.5.4`, `uuid@14.0.1`, `tailwindcss@4.3.2`, `typescript@5.9.3`,
  `vitest@4.1.9`, `@vitejs/plugin-react@6.0.3`.

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
again). Expected output (captured on a real run, 2026-07-02):

```
   ▲ Next.js 15.5.19 (Turbopack)

   Creating an optimized production build ...
 ✓ Compiled successfully in ~1s
   Linting and checking validity of types ...
   Collecting page data ...
Database initialized at: /Users/prestonbernstein/dev/book-seller/data/inventory.db
   (the line above repeats several times — one per worker that imports lib/db.ts; normal)
 ✓ Generating static pages (12/12)

Route (app)                         Size  First Load JS
┌ ○ /                                0 B         119 kB
├ ○ /_not-found                      0 B         119 kB
├ ƒ /api/books                       0 B            0 B
├ ƒ /api/books/[id]                  0 B            0 B
├ ƒ /api/books/[id]/status           0 B            0 B
├ ƒ /api/dashboard                   0 B            0 B
├ ƒ /api/export                      0 B            0 B
├ ƒ /api/import                      0 B            0 B
├ ƒ /api/isbn/[isbn]                 0 B            0 B
├ ○ /books                       1.83 kB         121 kB
├ ƒ /books/[id]                  2.67 kB         121 kB
├ ○ /books/add                   1.65 kB         120 kB
└ ƒ /dashboard                     598 B         119 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

**13 routes total.** Sizes/chunk hashes will drift; the route list is the signal.

Yes — the build itself imports `lib/db.ts` and touches the real DB (it runs the idempotent
migration and logs the `Database initialized at:` line). This is expected and safe; the
migration is `CREATE ... IF NOT EXISTS`-style init, not destructive. This is also why you
must run the build **from the repo root** — from anywhere else it would create a stray DB.

### Step 4 — verification checklist

- [ ] `npm ls --depth=0` — clean tree, no `invalid`/`missing`
- [ ] `npm run build` — exits 0, route table shows all 13 routes
- [ ] `file node_modules/better-sqlite3/build/Release/better_sqlite3.node` — matches your arch (arm64 here)
- [ ] No stray `data/` directories created outside the repo root (detection command in §3)
- [ ] **Did NOT run the test suite.** Testing = `book-seller-validation-and-qa`, which has
      the safe procedure. `npx vitest run` from here wipes the real DB.

Build green? You are done. Running the app is `book-seller-run-and-operate`.

---

## 3. First-run behavior of `lib/db.ts`

Any import of `lib/db.ts` (build, dev server, API route, script, test) executes this at
module load, in order (source: `/Users/prestonbernstein/dev/book-seller/lib/db.ts`):

1. Resolves DB path as `path.join(process.cwd(), 'data', 'inventory.db')` — **cwd, not repo root**.
2. `fs.mkdirSync` on the `data/` dir (recursive — creates it if absent).
3. Opens the DB with better-sqlite3 (creates an empty DB file if absent).
4. Pragmas: `journal_mode = WAL`, `foreign_keys = ON` (WAL is why `-wal`/`-shm` siblings exist).
5. Reads and executes `data/migrations/001_init.sql` — also resolved from `process.cwd()`,
   so from the wrong cwd this step **throws ENOENT** (after already creating the stray DB in steps 2–3).
6. Logs exactly: `` Database initialized at: ${dbPath} `` — e.g.
   `Database initialized at: /Users/prestonbernstein/dev/book-seller/data/inventory.db`.

**The cwd trap:** run any node/npm entrypoint that touches `lib/db.ts` from the wrong
directory and you get a stray empty `data/` dir + `inventory.db` wherever you were
standing. Check the logged path every time — if it is not
`/Users/prestonbernstein/dev/book-seller/data/inventory.db`, you created a stray.

Detection command (finds stray `data/inventory.db` files under home, excluding the real
one and noise dirs):

```sh
find ~ -maxdepth 4 -path "*/data/inventory.db" -not -path "*/dev/book-seller/*" -not -path "*/node_modules/*" 2>/dev/null
```

Expected output: nothing. Any hit is a stray — safe to delete **only after confirming it
is not the real DB** at `/Users/prestonbernstein/dev/book-seller/data/inventory.db`.

---

## 4. Known traps

| Trap | Symptom | Remedy / verify |
|---|---|---|
| Native module ABI after Node major switch | `ERR_DLOPEN_FAILED` / "was compiled against a different Node.js version" on any import of `lib/db.ts` (build, dev, everything) | `npm rebuild better-sqlite3` from the repo root, then verify: `node -e "require('better-sqlite3'); console.log('ok')"` → `ok` |
| Port 3000 squatter | An unrelated Flutter app usually holds port 3000; `next dev` **silently falls back to 3001**. Probing `http://localhost:3000` hits the wrong app with no error. | Read the dev server's startup output for the real port (`- Local: http://localhost:3001`). Never assume 3000. Kill any dev server you started when done. (Operating the dev server is `book-seller-run-and-operate`.) |
| Turbopack flag | Wondering why builds differ from stock Next docs | Both scripts carry it: `dev` = `next dev --turbopack`, `build` = `next build --turbopack`. Do not add/remove the flag; it is the project baseline. |
| `npm test` fails | `Missing script: "test"` | Expected — there is **no test or lint script** in `package.json`. This is not breakage. Do not "fix" it by adding a script that runs vitest (wipe trap, §CRITICAL). Safe testing: `book-seller-validation-and-qa`. |
| No `.env*` files | Looking for secrets/config to copy on a fresh machine | Absent **by design** — this app has no secrets. `.gitignore` excludes `.env*` defensively, but none exist and none are needed. Do not create one. App config lives in code: `book-seller-config-and-constants`. |
| `npm ci` surprise | node_modules vanished mid-debug | `npm ci` always deletes `node_modules/` first. Use `npm ls --depth=0` for cheap sync checks instead. |

---

## 5. Clean-rebuild recipe

Safe to delete (all regenerable):

| Path | Regenerated by |
|---|---|
| `.next/` | `npm run build` (or `npm run dev`) |
| `tsconfig.tsbuildinfo` | next TypeScript check during build |
| `node_modules/` | `npm ci` |

```sh
cd /Users/prestonbernstein/dev/book-seller
rm -rf .next tsconfig.tsbuildinfo node_modules
npm ci
npm run build   # expect the 13-route table from §2
```

**NEVER safe to delete — coordinator-approved rule:**

- `data/inventory.db`, `data/inventory.db-wal`, `data/inventory.db-shm` — the live
  inventory. The `-wal` file can hold unmerged writes; deleting it alone loses data.
- `data/backups/` — backups.
- `data/migrations/` — required by `lib/db.ts` at every startup (ENOENT without it).

Rule of thumb: **nothing under `data/` is ever cleanup material.** `.gitignore` excluding
`*.db` / `data/inventory.db` / `data/backups/` means git will never protect these files —
there is no recovery via checkout. (Repo has zero commits anyway.)

Note: since the build imports `lib/db.ts`, a "clean rebuild" still opens the real DB and
re-runs the idempotent migration. That is expected; it does not modify data.

---

## 6. When NOT to use this skill

- **Running or operating the app** (dev server lifecycle, prod start, DB care, backups) →
  `book-seller-run-and-operate`. This skill ends when `npm run build` is green.
- **Running tests** (safe vitest procedure, the DB-wipe hazard) → `book-seller-validation-and-qa`.
- **Diagnosing app bugs / runtime misbehavior** → `book-seller-debugging-playbook`,
  `book-seller-diagnostics-and-tooling`.
- **Understanding architecture, routes, data model** → `book-seller-architecture-contract`.
- **Changing config values or constants** → `book-seller-config-and-constants` (and
  `book-seller-change-control` for any change process).
- **Past incidents / why things are the way they are** → `book-seller-failure-archaeology`.
- **Domain questions about bookselling itself** → `bookselling-domain-reference`.
- **Docs/writing, research, analysis** → `book-seller-docs-and-writing`,
  `book-seller-research-frontier`, `book-seller-analysis-and-methodology`.

---

## Provenance and maintenance

Authored 2026-07-02 by direct verification on the target machine (macOS arm64, Node
v24.16.0, npm 11.13.0, sqlite3 CLI 3.51.0): read `package.json`, `package-lock.json`,
`tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `.gitignore`,
`lib/db.ts`; ran `npm run build` (route table pasted verbatim) and `npm ls --depth=0`.
The vitest DB-wipe hazard was verified 2026-07-02 by reading `tests/integration.test.ts`
— NOT by running it.

Versions WILL drift. One-line re-verification commands:

```sh
node --version && npm --version && sqlite3 --version            # toolchain baseline
cd /Users/prestonbernstein/dev/book-seller && npm ls --depth=0  # dep tree vs lockfile
cd /Users/prestonbernstein/dev/book-seller && npm run build     # route table still 13 routes?
file /Users/prestonbernstein/dev/book-seller/node_modules/better-sqlite3/build/Release/better_sqlite3.node  # native binary arch
grep -n "process.cwd()" /Users/prestonbernstein/dev/book-seller/lib/db.ts  # cwd trap still present?
sed -n '130,145p' /Users/prestonbernstein/dev/book-seller/tests/integration.test.ts  # wipe trap still present?
```

If any re-verification diverges from this file, update the affected section and refresh
the date above.
