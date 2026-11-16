# Core rules for agents

This file lists the gate commands and hard rules for this repo. The gates enforce them. This file only guides.

## Commands

- Install: `npm ci`. It needs read access to the private `credential-crypto` repo.
- Run the gates before you say a task is done. CI runs the same scripts.
  - Core: `bash scripts/core-validate.sh` (file size, names, complexity, length, parameters, nesting, duplication).
  - TypeScript: `bash scripts/ts-validate.sh` (tsc, eslint, vitest). `TS_E2E=1` adds Playwright.
  - GitHub Actions: `bash scripts/gha-validate.sh` (pins, permissions, actionlint, zizmor).
  - Postgres: `bash scripts/pg-validate.sh` (migrations unchanged, Squawk, SQLFluff).
  - Writing: `bash scripts/writing-validate.sh` (Vale on changed files).
  - JavaScript: `bash scripts/js-validate.sh`. It fails today; see Traps.
- Turn on the hook once per clone: `git config core.hooksPath .githooks`. Never commit with `--no-verify`.

## Rules

- Reuse before you write. Extend what exists. Extract on the second real use.
- Put variants in data and generic code, not in copies. No boolean flag arguments.
- Organize by domain, not by kind. No file named `utils`, `helpers`, `misc`, `common` or `manager`.
- A function does one thing. Use guard clauses. Keep it under 50 lines, 10 branches and 4 parameters.
- Fail loudly. Do not swallow errors. Comments say why, not what.
- A behavior change ships with a test that fails without it.
- Never edit a limit, a baseline or a config to make a run pass. Fix the code, or waive it with a reason.
- Pin every GitHub Action to a full commit SHA. Set `permissions: contents: read`, `persist-credentials: false` and `timeout-minutes`.
- Never put `github.event.*` or `inputs.*` inside `run:`. Pass it through `env:`.
- No `any`, `@ts-ignore` or floating promises. Use `import type` for type-only imports.
- Never edit an applied migration. Add a new one.
- Write short, plain, American English in docs and comments.

## Traps

- `.core-baseline.json` and `.core-allow` may shrink, never grow. Write the baseline with the pinned lizard (`bash .github/gate-tools/install.sh` installs the pinned tools).
- `data/migrations` holds SQLite SQL, not Postgres. `.pg-allow` leaves it out of Squawk and SQLFluff.
- The JavaScript gate fails on two findings. `credential-crypto` is a git dependency: publish it to a registry to fix that. `package.json` has no `type`: `commonjs` breaks `next build` and `module` breaks `__dirname` in the Playwright configs.
- `.npmrc` sets only `min-release-age`. `ignore-scripts` would stop `better-sqlite3` from building.
- Tests run against a scratch database set in `vitest.config.ts`. Never point them at `data/inventory.db`.
