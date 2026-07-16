# Tasks: Playwright QA Harness

Generated from: docs/playwright-qa-harness/ on 2026-07-16

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Add `createBookItem` helper to `tests/e2e/helpers.ts`
**Status**: [x] done
**Files**: tests/e2e/helpers.ts
**Test**: `npm run typecheck` passes with no errors in helpers.ts; `grep "export.*createBookItem" tests/e2e/helpers.ts` confirms export.
**Depends on**: none
**Parallelizable**: No
**Notes**: Also had to `npm install` + `npx playwright install chromium` in this fresh worktree (node_modules didn't exist yet) before typecheck/tests could run at all.

### Task 2: Add `test:e2e:flaky-check` npm script
**Status**: [x] done
**Files**: package.json
**Test**: `npm run test:e2e:flaky-check -- --help` runs without error.
**Depends on**: none
**Parallelizable**: No
**Notes**:

### Task 3: Replace inline book-item creation in `tests/e2e/phone-handoff.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/phone-handoff.spec.ts
**Test**: `npx playwright test tests/e2e/phone-handoff.spec.ts --project=chromium --repeat-each=3` passes; zero local `createBookItem` declarations remain.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 4: Replace inline book-item creation in `tests/e2e/book-flow.spec.ts` and `tests/e2e/photo-upload.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/book-flow.spec.ts, tests/e2e/photo-upload.spec.ts
**Test**: `npx playwright test tests/e2e/book-flow.spec.ts tests/e2e/photo-upload.spec.ts --project=chromium --repeat-each=3` passes; zero local book-creation declarations remain in either file.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 5: Replace combined book+clothing creation in `tests/e2e/dashboard.spec.ts` and `tests/e2e/search-filter.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/dashboard.spec.ts, tests/e2e/search-filter.spec.ts
**Test**: `npx playwright test tests/e2e/dashboard.spec.ts tests/e2e/search-filter.spec.ts --project=chromium --repeat-each=3` passes; zero local combined-creation functions remain.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 6: Replace inline book-item creation in `tests/e2e/csv-export-import.spec.ts` and fix suffix scope bug
**Status**: [x] done
**Files**: tests/e2e/csv-export-import.spec.ts
**Test**: `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3` passes with zero flakes; suffix declared inside test scope, not module scope.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 7: Add full-field CSV round-trip test to `tests/e2e/csv-export-import.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/csv-export-import.spec.ts
**Test**: `npx playwright test tests/e2e/csv-export-import.spec.ts --project=chromium --repeat-each=3` passes zero flakes; every populated column round-trips; includes a non-round-dollar value.
**Depends on**: Task 6
**Parallelizable**: No
**Notes**:

### Task 8: Add session persistence test to `tests/e2e/auth-pages.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/auth-pages.spec.ts
**Test**: `npx playwright test tests/e2e/auth-pages.spec.ts --project=chromium --repeat-each=3` passes zero flakes; session survives nav+reload without re-login; item remains visible.
**Depends on**: Task 1
**Parallelizable**: No
**Notes**:

### Task 9: Audit `playwright.config.ts` and spec files for stale assumptions and data/ path leaks
**Status**: [x] done
**Files**: playwright.config.ts, tests/e2e/phone-handoff.spec.ts, tests/e2e/book-flow.spec.ts, tests/e2e/photo-upload.spec.ts, tests/e2e/dashboard.spec.ts, tests/e2e/search-filter.spec.ts, tests/e2e/csv-export-import.spec.ts, tests/e2e/auth-pages.spec.ts
**Test**: Direct read shows zero stale single-tenant/no-auth assumptions; git grep for data/ paths and page.waitForTimeout in modified files returns zero results.
**Depends on**: Task 1, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8
**Parallelizable**: No
**Notes**:

### Task 10: Verify marketplace-connector coverage via existing `tests/e2e/connections-flow.spec.ts`
**Status**: [x] done
**Files**: tests/e2e/connections-flow.spec.ts (no modifications)
**Test**: `npx playwright test tests/e2e/connections-flow.spec.ts --project=chromium` exits 0, all tests pass.
**Depends on**: Task 9
**Parallelizable**: No
**Notes**:

### Task 11: Run new/modified specs with `--repeat-each=3` for determinism
**Status**: [x] done
**Files**: tests/e2e/phone-handoff.spec.ts, tests/e2e/book-flow.spec.ts, tests/e2e/photo-upload.spec.ts, tests/e2e/dashboard.spec.ts, tests/e2e/search-filter.spec.ts, tests/e2e/csv-export-import.spec.ts, tests/e2e/auth-pages.spec.ts (execution only)
**Test**: All 7 files pass 3x consistently as a batch and individually (2 spot-checked in isolation).
**Depends on**: Task 1, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10
**Parallelizable**: No
**Notes**:

### Task 12: Run full test suite 3 consecutive times for stability (AC2)
**Status**: [x] done
**Files**: (execution only)
**Test**: `npm run test:e2e` x3 produces identical pass/fail results, exit code 0 each time, report artifact produced each run.
**Depends on**: Task 11
**Parallelizable**: No
**Notes**:

### Task 13: Fix application defects and add regression assertions
**Status**: [x] done (no defects found)
**Files**: none — no application code changes needed
**Test**: For each defect found: fix, regression assertion added, revert-confirms-failure, restore-confirms-pass; final `npm run test:e2e` passes.
**Depends on**: Task 12
**Parallelizable**: No
**Notes**: Zero real application defects surfaced across all 8 build-out tasks, the isolation spot-checks, and 3 full-suite runs (including the full-field CSV round-trip test specifically designed to catch a money-rounding defect — none found). One benign observation: recurring `next/image` dev-mode "isn't a valid image" server warnings during photo-upload.spec.ts's delete step, traced to app/api/items/[id]/photos/[photoId]/route.ts — this is Next's image optimizer hitting an expected 404 for a photo mid-delete; the route's 404 behavior is correct and every delete/reupload/reload assertion passes. Not a defect, not fixed.

## Blocked / open
(populated during implementation)
