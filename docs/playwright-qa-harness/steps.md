# Steps: Playwright QA Harness

## Prerequisites
- Existing Playwright infrastructure in place: `playwright.config.ts`, `tests/e2e/` with 11 spec files, `tests/e2e/helpers.ts`, `tests/e2e/auth.setup.ts`, and `.playwright-scratch/` directory configured via env vars.
- `npm run test:e2e` entry point works and runs specs against scratch DB/photos/credential-key paths (never `data/`).
- All target spec files exist and contain inline book-item-creation logic to be refactored.

## Implementation steps

### Step 1: Add `createBookItem` helper to `tests/e2e/helpers.ts`
**What**: Create a new `createBookItem(page, book: { title, author?, cost?, date? })` helper function that mimics the existing `createClothingItem` pattern—navigates to `/inventory/new`, fills form fields via `inputByLabel`, submits, and returns to `/inventory`.
**Files**: `tests/e2e/helpers.ts`
**Test**: `npm run typecheck` passes with no errors in `helpers.ts` and `grep "export.*createBookItem" tests/e2e/helpers.ts` confirms the new function is properly exported.
**Depends on**: none
**Parallelizable**: No

### Step 1b: Add `test:e2e:flaky-check` npm script
**What**: Add a new npm script to `package.json` under the scripts section: `"test:e2e:flaky-check": "playwright test --project=chromium --repeat-each=3"` to provide a permanent, discoverable way to run the determinism check without manually typing the full command.
**Files**: `package.json`
**Test**: `npm run test:e2e:flaky-check -- --help` runs without error and outputs Playwright help text, confirming the script is properly wired.
**Depends on**: none
**Parallelizable**: No

### Step 2a: Replace inline book-item creation in `tests/e2e/phone-handoff.spec.ts`
**What**: Delete the local `createBookItem` function (which reimplements label->xpath->input logic inline) and replace all its call sites with `helpers.createBookItem`. This file's locator strategy is the FR4-relevant fix. Import the helper at the top of the file and verify all references to the old function are removed.
**Files**: `tests/e2e/phone-handoff.spec.ts`
**Test**: `npx playwright test tests/e2e/phone-handoff.spec.ts --project=chromium --repeat-each=3` passes with exit code 0; file contains zero `createBookItem` local declarations (verify via `grep -n "function createBookItem\|const createBookItem" tests/e2e/phone-handoff.spec.ts` returns zero matches).
**Depends on**: Step 1
**Parallelizable**: No

### Step 2b: Replace inline book-item creation in `tests/e2e/book-flow.spec.ts` and `tests/e2e/photo-upload.spec.ts`
**What**: In each file, delete the local book-creation function declaration and replace all call sites with `helpers.createBookItem`; import the helper at the top. These files have straightforward inline book-creation logic with no special cost assertions.
**Files**: `tests/e2e/book-flow.spec.ts,tests/e2e/photo-upload.spec.ts`
**Test**: `npx playwright test tests/e2e/book-flow.spec.ts tests/e2e/photo-upload.spec.ts --project=chromium --repeat-each=3` passes with exit code 0; both files contain zero local `createBookItem` declarations (verify via `grep -c "function createBookItem\|const createBookItem" tests/e2e/book-flow.spec.ts tests/e2e/photo-upload.spec.ts` returns 0 for both).
**Depends on**: Step 1
**Parallelizable**: No

### Step 2c: Replace combined book+clothing creation in `tests/e2e/dashboard.spec.ts` and `tests/e2e/search-filter.spec.ts`
**What**: Each of these files currently has a COMBINED function that creates both a book AND a clothing item in one call. Decompose into two separate helper calls: `helpers.createBookItem` + `helpers.createClothingItem`, with the caller generating and threading its own unique title/brand via `uniqueSuffix()`. IMPORTANT: dashboard.spec.ts and search-filter.spec.ts each have their own hardcoded cost values used in later assertions (e.g., `expect(...).toContain("$X.XX")`). When calling `helpers.createBookItem`, pass the exact cost value that the file's assertions expect, never omit it or rely on a default, or the assertions will silently check the wrong number.
**Files**: `tests/e2e/dashboard.spec.ts,tests/e2e/search-filter.spec.ts`
**Test**: `npx playwright test tests/e2e/dashboard.spec.ts tests/e2e/search-filter.spec.ts --project=chromium --repeat-each=3` passes with exit code 0; both files contain zero local combined-creation functions; line-by-line diff shows the cost value passed to `helpers.createBookItem` exactly matches the cost value expected by the file's later assertions.
**Depends on**: Step 1
**Parallelizable**: No

### Step 2d: Replace inline book-item creation in `tests/e2e/csv-export-import.spec.ts` and fix suffix scope bug
**What**: Delete the local book-creation function and replace with `helpers.createBookItem`. Additionally, fix a pre-existing bug: this file's `suffix` constant is computed once at module load (outside any test scope), which breaks under `--repeat-each=3` because all 3 repeats reuse the same suffix, causing title/ISBN collisions on repeats 2 and 3. Move suffix generation to per-test scope (e.g., inside the test body or a beforeEach hook scoped to that test) so each repeat gets a unique suffix.
**Files**: `tests/e2e/csv-export-import.spec.ts`
**Test**: `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3` passes with exit code 0 and zero flakes; file contains zero module-level `suffix` declarations; `grep -n "const suffix\|let suffix" tests/e2e/csv-export-import.spec.ts | head -1` shows suffix is declared inside test scope, not at module level.
**Depends on**: Step 1
**Parallelizable**: No

### Step 3: Add full-field CSV round-trip test to `tests/e2e/csv-export-import.spec.ts`
**What**: Add a new test that constructs CSV row(s) with every book field (title, author, condition, cost, original-date-acquired) and every clothing field (brand, size, category, condition, cost, original-date-acquired) using the file's existing buildCsv/buildCsvRow pattern (direct CSV string construction, not exporting the full existing DB and reimporting). Include at least one non-round-dollar monetary value (e.g., $19.99) in the fixture so the test can actually catch a money-rounding defect. Import the row(s) via `POST /api/import`, export via `GET /api/export`, parse the response, and assert all populated fields round-trip byte-for-byte (excluding id, created-at, updated-at, and sale-only columns per the API's documented behavior). Do NOT export and reimport the FULL existing dataset, which would risk duplicating every prior row in a DB that is never wiped and break dashboard.spec.ts's and search-filter.spec.ts's count assertions.
**Files**: `tests/e2e/csv-export-import.spec.ts`
**Test**: `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3` passes zero flakes; test output shows at least one row with $X.99 cost (non-round-dollar) successfully round-tripped; diff output shows every input column present in export with no loss or corruption.
**Depends on**: Step 2d
**Parallelizable**: No

### Step 4: Add session persistence test to `tests/e2e/auth-pages.spec.ts`
**What**: Add a new test to the "Signup page" suite that exercises session durability under navigation and reload: use the DEFAULT already-authenticated storageState (inherited from `auth.setup.ts`, same as every other spec file), create an item, navigate via `page.goto` to a different route (e.g., `/inventory`), then do a full `page.reload()`, and assert (a) the tenant is still authenticated (session cookie present, no redirect to login), and (b) the item created before reload is still visible. Do NOT override `storageState` to empty or re-sign up through the UI — that would create a new tenant on every run in a DB that is never wiped, violating the "one E2E tenant" invariant.
**Files**: `tests/e2e/auth-pages.spec.ts`
**Test**: `npx playwright test tests/e2e/auth-pages.spec.ts --project=chromium --repeat-each=3` passes zero flakes; assertions verify session survives navigation via `page.goto` and full-page reload via `page.reload()`, and the item created during the session remains visible after reload without requiring re-login.
**Depends on**: Step 1
**Parallelizable**: No

### Step 5: Audit `playwright.config.ts` and spec files for stale assumptions and data/ path leaks
**What**: Directly READ (not just grep) `playwright.config.ts` and each newly modified/added spec file from Steps 1, 2a, 2b, 2c, 2d, 3, 4 to check for stale single-tenant/no-auth assumptions phrased in any form (not just exact keyword matches). Then run explicit grep queries: (a) `git grep -n "data/inventory\.db\|data/photos\|data/credentials" -- tests/e2e/ playwright.config.ts` and confirm zero results (AC7 — all file paths must use scratch-path env vars, never direct `data/` paths); (b) `git grep -n "page.waitForTimeout" -- tests/e2e/` over all newly modified spec files and confirm zero results (use proper wait strategies, not timeouts); (c) `git grep -n "css(\\|xpath(\\|locator(\"[^\"]*['\\\\/]" -- tests/e2e/` (conservative XPath/CSS selector check) over newly modified files and confirm all selectors are generated via `helpers.fieldWrapper` or `helpers.inputByLabel`, not hardcoded; note playwright.config.ts has already been confirmed clean by direct read during planning, so this step's remaining work is auditing the spec files.
**Files**: `playwright.config.ts,tests/e2e/phone-handoff.spec.ts,tests/e2e/book-flow.spec.ts,tests/e2e/photo-upload.spec.ts,tests/e2e/dashboard.spec.ts,tests/e2e/search-filter.spec.ts,tests/e2e/csv-export-import.spec.ts,tests/e2e/auth-pages.spec.ts`
**Test**: Direct read of playwright.config.ts and all listed spec files shows zero instances of stale single-tenant/no-auth assumptions; `git grep -n "data/inventory\.db\|data/photos\|data/credentials" -- tests/e2e/ playwright.config.ts` returns zero results; `git grep -n "page.waitForTimeout" -- tests/e2e/phone-handoff.spec.ts tests/e2e/book-flow.spec.ts tests/e2e/photo-upload.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/search-filter.spec.ts tests/e2e/csv-export-import.spec.ts tests/e2e/auth-pages.spec.ts` returns zero results; selector usage is via helpers only.
**Depends on**: Step 1, Step 2a, Step 2b, Step 2c, Step 2d, Step 3, Step 4
**Parallelizable**: No

### Step 6: Verify marketplace-connector coverage via existing `tests/e2e/connections-flow.spec.ts`
**What**: Run `tests/e2e/connections-flow.spec.ts` once standalone and confirm it passes. This file exercises the Depop marketplace connector's consent→credential→first-win flow and satisfies the marketplace-connector requirement via verification of already-existing coverage (no new code, just confirming pre-existing tests still work after all prior refactors).
**Files**: `tests/e2e/connections-flow.spec.ts` (no modifications)
**Test**: `npx playwright test tests/e2e/connections-flow.spec.ts --project=chromium` runs with exit code 0 and all tests pass; console output shows no stale-state or auth errors.
**Depends on**: Step 5
**Parallelizable**: No

### Step 7: Run new/modified specs with `--repeat-each=3` for determinism
**What**: Execute the explicit list of new and modified spec files (phone-handoff, book-flow, photo-upload, dashboard, search-filter, csv-export-import, auth-pages) with `--repeat-each=3` to ensure they pass three consecutive times with zero flakes; fix any timing-sensitive assertions or waits that surface. Additionally, run at least 2 of these spec files individually/in isolation (e.g., `npx playwright test tests/e2e/phone-handoff.spec.ts --project=chromium --repeat-each=3` and `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3`) to spot-check that no spec silently depends on another spec's leftover state.
**Files**: `tests/e2e/phone-handoff.spec.ts,tests/e2e/book-flow.spec.ts,tests/e2e/photo-upload.spec.ts,tests/e2e/dashboard.spec.ts,tests/e2e/search-filter.spec.ts,tests/e2e/csv-export-import.spec.ts,tests/e2e/auth-pages.spec.ts` (test execution only; if fixes needed, the affected spec files from Steps 2-4)
**Test**: `npx playwright test tests/e2e/phone-handoff.spec.ts tests/e2e/book-flow.spec.ts tests/e2e/photo-upload.spec.ts tests/e2e/dashboard.spec.ts tests/e2e/search-filter.spec.ts tests/e2e/csv-export-import.spec.ts tests/e2e/auth-pages.spec.ts --project=chromium --repeat-each=3` completes with exit code 0; all 7 spec files pass 3x consistently. Additionally, run `npx playwright test tests/e2e/phone-handoff.spec.ts --project=chromium --repeat-each=3` in isolation and confirm exit code 0; run `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3` in isolation and confirm exit code 0 (verifies no hidden dependency on another spec's state).
**Depends on**: Steps 1, 2a, 2b, 2c, 2d, 3, 4, 5, 6
**Parallelizable**: No

### Step 8: Run full test suite 3 consecutive times for stability (AC2)
**What**: Execute the entire E2E suite via `npm run test:e2e` three consecutive times on an unchanged codebase to verify zero flakes across all 11 spec files (new, modified, and existing); confirm identical pass/fail results across all three runs. After each of the 3 runs, verify (a) a report artifact/output is produced (list reporter locally, or html+github reporters on CI if running in CI—already configured, no new reporter code needed) and (b) the process exit code is 0 on success.
**Files**: (test execution only)
**Test**: Run `npm run test:e2e` three times in succession. After each run: (a) verify `echo $?` is 0 (exit code success); (b) check that Playwright generated a report artifact (default: `playwright-report/` directory with index.html exists, or CI artifacts if running on GitHub Actions—existing reporters already handle this). After all three runs complete, diff the three reports and verify all three runs show identical pass/fail outcomes; exit code 0 each time.
**Depends on**: Step 7
**Parallelizable**: No

### Step 9: Fix application defects and add regression assertions
**What**: For each defect the new/modified specs surfaced during Steps 7-8 (e.g., a CSV column not surviving import, a session not persisting across reload, a form validation error), treat it as an independently reversible unit: (1) fix the bug in application code under `app/lib/components/` or similar, (2) add or extend a spec assertion that fails against the pre-fix code and passes against the fix, (3) re-run the affected spec to confirm the regression assertion catches the original defect, (4) revert the app-code fix via `git checkout -- app/<path>`, re-run the affected spec, and confirm the regression assertion fails, (5) restore the fix via `git checkout HEAD -- app/<path>` or by re-applying the change, and confirm the assertion passes. Each defect fix should be its own git commit (with a clear commit message linking it to the spec that caught it) rather than one big undifferentiated step, so individual fixes can be easily reverted if needed.
**Files**: (conditional; only modified if defects found) Application code under `app/` + any affected spec files from Steps 2-4
**Test**: For each defect: (a) apply the fix and run the affected spec—verify exit code 0 and the regression assertion passes; (b) revert the fix via `git checkout -- app/<path>`, re-run the affected spec, and confirm the regression assertion fails (proving the test catches the defect); (c) restore the fix and re-run—confirm the assertion passes again. After all defects are fixed, run `npm run test:e2e` one final time and confirm all suites pass with exit code 0.
**Depends on**: Step 8
**Parallelizable**: No

## Rollback plan
- **Steps 1, 1b (helpers and npm script):** Changes are additive. Rollback via `git checkout -- tests/e2e/helpers.ts package.json`.
- **Steps 2a-2d (spec file refactors):** Each file's swap of inline book-creation for the shared helper is independently revertible via `git checkout -- tests/e2e/<filename>` for the specific file (e.g., `git checkout -- tests/e2e/phone-handoff.spec.ts` to revert only that file). The suffix-scope fix in Step 2d is included in the same file's checkout.
- **Step 3 (CSV round-trip test):** New test added to `tests/e2e/csv-export-import.spec.ts`; revert the entire Step 2d/3 changes via `git checkout -- tests/e2e/csv-export-import.spec.ts` (or just revert Step 3's test addition by selectively undoing the new test function).
- **Step 4 (session persistence test):** New test added to `tests/e2e/auth-pages.spec.ts`; revert via `git checkout -- tests/e2e/auth-pages.spec.ts`.
- **Step 5 (merged audit):** No code changes; only review and documentation. No rollback needed.
- **Step 6 (connections-flow verification):** No code changes; only test execution. No rollback needed.
- **Steps 7-8 (determinism and full-suite runs):** No code changes; if a timing issue is discovered and a spec fix is applied inline, capture it via `git diff` before committing or discarding.
- **Step 9 (defect fixes):** Each defect fix should be its own git commit. Rollback a single defect fix via `git revert <commit-hash>` or `git checkout -- app/<path>` for that specific app file. Re-run `npm run test:e2e` to confirm the spec assertion and the app code are both correctly aligned after rollback.
- **General:** All steps use only `git checkout` or `git revert` on tracked files; no files added to `.gitignore` or deleted without recovery options. Scratch DB/photos at `.playwright-scratch/` are ephemeral and can be wiped via `rm -rf .playwright-scratch/` without data loss.

