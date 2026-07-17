# Tasks: Reseller Seeded Vocabularies

Generated from: docs/reseller-seeded-vocabularies/ on 2026-07-17

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Create migration DDL for clothing_colors/clothing_materials/clothing_departments tables
**Status**: [x] done
**Files**: data/migrations/012_clothing_vocabularies.sql, lib/db.ts, tests/api/tenant-isolation.test.ts
**Test**: Trigger migration against scratch DB via `npx vitest run`; verify `.schema clothing_colors`/materials/departments show id/tenant_id/canonical_name columns; verify idx_clothing_details_tenant index exists. Confirm `lib/db.ts`'s VERSIONED_MIGRATIONS array includes `{ version: 12, file: '012_clothing_vocabularies.sql' }` (mirroring the version-11 entry) — without this the migration file never runs.
**Depends on**: none
**Parallelizable**: no
**Notes**: Implementation agent flagged AC13's hardcoded `expect(userVersion).toBe(11)` in tests/api/tenant-isolation.test.ts (line 178/192) as a real blocker outside its file scope — every prior migration bump required updating this same assertion. Fixed directly by orchestrator (11→12 in both the `it()` description and the assertion); `npx vitest run tests/api/tenant-isolation.test.ts` now passes (19/19).

### Task 2: Seed clothing_colors/clothing_materials/clothing_departments for existing tenants
**Status**: [x] done
**Files**: data/migrations/012_clothing_vocabularies.sql
**Test**: Verify 14/14/5 seeded values per existing tenant; re-run only the INSERT OR IGNORE blocks a second time and confirm row counts unchanged.
**Depends on**: Task 1
**Parallelizable**: no
**Notes**: Implementation agent found SQLite rejects the plan's exact `CROSS JOIN (VALUES ...) AS v(name)` syntax (confirmed independently: `sqlite3` 3.51.0 → "near '(': syntax error" — SQLite doesn't support column-alias lists on derived tables, unlike PostgreSQL). Rewrote as `WITH v(name) AS (VALUES ...) ... CROSS JOIN v` CTEs — same values, same apostrophe escaping, same CROSS JOIN semantics, just SQLite-valid syntax. Verified independently by orchestrator: applied all 12 migrations to a fresh scratch DB, confirmed 14/14/5 row counts per tenant and correct escaping (Kids', Men's, Women's), confirmed clothing_brands still at 0 rows (Task 3 not yet run).

### Task 3: Backfill clothing_brands with starter brands for existing tenants
**Status**: [x] done
**Files**: data/migrations/012_clothing_vocabularies.sql
**Test**: Verify 25 seeded brand values per existing tenant, no duplicates.
**Depends on**: Task 1
**Parallelizable**: no
**Notes**: Used the corrected CTE syntax from Task 2. Verified independently by orchestrator: fresh scratch DB, all 12 migrations applied, 25 distinct brands per tenant, correct "Levi's" escaping, 0 CHECK-constraint violations on the UUIDv4-shaped id.

### Task 4: Create shared seed helper for future tenants
**Status**: [x] done
**Files**: lib/vocabSeed.ts
**Test**: Import module, verify 4 arrays have correct lengths (14,14,5,25) and spot-check exact values; call seedStarterVocabulary(testTenantId) and verify all 4 tables populated.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: Verified by orchestrator — arrays match migration 012 exactly, transaction-wrapped plain INSERTs across all 4 tables using uuid v4 ids.

### Task 5: Wire seeding into tenant creation
**Status**: [x] done
**Files**: lib/tenantAuth.ts
**Test**: Call createTenant() with a new tenant; verify clothing_colors count is 14 for that tenant; verify DuplicateEmailError/WeakPasswordError still propagate.
**Depends on**: Task 4
**Parallelizable**: no
**Notes**: Verified independently — better-sqlite3@12.11.1 genuinely supports nested db.transaction() via SAVEPOINT (confirmed with a standalone script), so seedStarterVocabulary's internal transaction composes cleanly into createTenant's outer one. Side effect discovered: this makes every createTestTenant() call in the test suite start with 25 seeded brands — see Task 16.

### Task 6: Create shared vocab-resolver factory plus color/material/department instantiations
**Status**: [x] done
**Files**: lib/vocabResolver.ts, lib/colors.ts, lib/materials.ts, lib/departments.ts
**Test**: resolveCanonicalColor with existing/new/whitespace values; concurrent-race handling; validateColorInput/validateMaterialInput/validateDepartmentInput with "", undefined, valid, >255-char inputs (undefined and "" must both be valid — optional fields); selectCanonicalColor missing-value returns null.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: Verified by orchestrator — factory + 3 instantiations match spec exactly, written fresh without touching lib/brands.ts.

### Task 7: Create GET /api/colors, /api/materials, /api/departments endpoints
**Status**: [x] done
**Files**: app/api/colors/route.ts, app/api/materials/route.ts, app/api/departments/route.ts
**Test**: Authenticated GET returns correct shape/ordering/seeded values; unauthenticated returns 401; tenant-scoping confirmed.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: Verified by orchestrator — all 3 files read back correctly, each an exact copy of app/api/brands/route.ts with correct table name, response key, and error message per endpoint.

### Task 8: Create reusable VocabCombobox component
**Status**: [x] done
**Files**: components/VocabCombobox.tsx
**Test**: Render with endpoint /api/colors; type "bl" filters to Black/Blue (NOT Multicolor — see Notes); type unseeded value shows "Add ... as new" option; ArrowDown x2 + Enter selects; Escape closes; keystroke commits onChange.
**Depends on**: Task 7
**Parallelizable**: yes
**Notes**: Verified by orchestrator — matches spec exactly, correctly generalizes BrandCombobox. Implementation agent flagged a real bug in this spec's original test description (steps.md Step 6 / this task's Test field, inherited from spec-gather): "Multicolor" does NOT contain the substring "bl" (M-u-l-t-i-c-o-l-o-r has no "bl"), so typing "bl" filters to Black and Blue only, not Multicolor. Fixed here and in steps.md for Task 13 to use the correct expectation.

### Task 9: Wire resolve and validation into clothing item creation
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: Submit with case-variant color resolves to canonical casing; new color creates row; >255-char color returns 422; empty color creates item with NULL color.
**Depends on**: Task 6
**Parallelizable**: yes
**Notes**: Verified by orchestrator — full suite run (1818 passed / 22 skipped, only the two not-yet-written stub test files fail as expected). Agent correctly preserved explicit-null-is-valid behavior for color/material/gender_department by bypassing the shared validator for null (it only special-cases undefined/'').

### Task 10: Replace datalist inputs with VocabCombobox in AddClothingForm
**Status**: [x] done
**Files**: components/AddClothingForm.tsx
**Test**: Three fields render as role="combobox"; existing Playwright .fill() helpers on color/material/department still pass; brand/size/condition unchanged; old colorOptions/materialOptions/departmentOptions state and useEffect removed.
**Depends on**: Task 8, Task 9
**Parallelizable**: no
**Notes**: Verified by orchestrator — all 3 VocabCombobox instances correctly configured, including the critical suggestionField="gender_department" literal (requirement 21).

### Task 11: Write API endpoint tests for vocabulary endpoints
**Status**: [x] done
**Files**: tests/api/colors.test.ts, tests/api/materials.test.ts, tests/api/departments.test.ts
**Test**: All pass; coverage thresholds met for the three route files.
**Depends on**: Task 7
**Parallelizable**: yes
**Notes**: Verified by orchestrator — 15/15 tests pass, correctly accounted for the seeded baseline from the start.

### Task 12: Write lib helper tests for vocabulary resolvers
**Status**: [x] done
**Files**: lib/__tests__/vocabResolver.test.ts
**Test**: `npx vitest run lib/__tests__/vocabResolver.test.ts`; all pass; coverage thresholds met for lib/vocabResolver.ts, lib/colors.ts, lib/materials.ts, lib/departments.ts.
**Notes**: Verified by orchestrator — 50/50 tests pass, 100% coverage on lib/vocabResolver.ts. Agent flagged a fixture collision risk in Task 13's file (VocabCombobox.test.tsx using "Linen" which is now a seeded material) — Task 13 is a separate in-flight task, will check on completion.
**Depends on**: Task 6
**Parallelizable**: yes
**Notes**:

### Task 13: Write VocabCombobox component tests
**Status**: [x] done
**Files**: components/__tests__/VocabCombobox.test.tsx
**Test**: All pass; coverage thresholds met.
**Depends on**: Task 8
**Parallelizable**: yes
**Notes**: Verified by orchestrator — 28/28 tests pass; no fixture collision issue materialized (test uses mocked fetch, doesn't touch the real seeded DB).

### Task 14: Verify end-to-end form submission and vocabulary deduplication
**Status**: [x] done
**Files**: tests/e2e/clothing-flow.spec.ts
**Test**: Submitting new color/material/department value creates canonical row; case-variant resubmission does not duplicate; existing .fill() helpers unaffected.
**Depends on**: Task 10, Task 9
**Parallelizable**: no
**Notes**: Verified by orchestrator against a real dev server — full suite (15/15) passes, including 2 new Color VocabCombobox tests.

### Task 15: Run full test suite and coverage report
**Status**: [x] done
**Files**: none (suite execution only)
**Test**: Full suite passes; coverage thresholds maintained; no regression in brand/size/condition/book tests.
**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12, Task 13, Task 14
**Parallelizable**: no
**Notes**: 1896/1896 tests pass (22 pre-existing skips), 100 test files pass, exit code 0. Coverage: statements 95.32%, branches 91.03%, functions 93.77%, lines 96.32% — all well above this repo's configured thresholds (85/80/85/85).

### Task 16: Fix tests/api/brands.test.ts for the new seeded-baseline reality
**Status**: [x] done
**Files**: tests/api/brands.test.ts
**Test**: `npx vitest run tests/api/brands.test.ts` — all pass.
**Depends on**: Task 5
**Parallelizable**: no
**Notes**: Discovered by orchestrator after Task 5 landed — `tests/helpers/tenant.ts::createTestTenant()` calls `createTenant()` directly, so every test tenant now starts with 25 seeded clothing_brands rows (not 0). 9 of 11 tests in this file broke: several literally use seeded brand names as their "new/unseeded" test fixture (Nike, Patagonia, Carhartt, Zara, Adidas are all in STARTER_BRANDS), and several assert `toHaveLength(1)` on the whole table where it's now `toHaveLength(25)` or more. Needs assertions rewritten to either use genuinely-unseeded brand names (e.g. "Dickies", "Wrangler" — not in the 25-item seed list) for "new brand" tests, or scope row-count checks to a specific canonical_name via `WHERE canonical_name = ? COLLATE NOCASE` rather than the whole table, matching the pattern the existing concurrent-race test (line ~114) already uses correctly.

### Task 17: Harden pass — fallow duplication + dead-code fixes
**Status**: [x] done
**Files**: components/comboboxHelpers.ts (new), components/BrandCombobox.tsx, components/VocabCombobox.tsx, lib/vocabSeed.ts
**Test**: `npx fallow check` clean; `npx tsc --noEmit` clean; `npx eslint .` 0 errors; full vitest suite (1896/1896) + e2e clothing-flow (15/15) still pass.
**Depends on**: Task 8, Task 10, Task 13 (all combobox work)
**Parallelizable**: no
**Notes**: `fallow check` found two real issues after implementation: (1) `rankByFrequency`/`moveHighlightIndex`/`buildComboOptions` were byte-for-byte duplicated between BrandCombobox.tsx and VocabCombobox.tsx (VocabCombobox was written fresh per scope, not by importing BrandCombobox, which produced the clone) — extracted into a new shared `components/comboboxHelpers.ts`, with both components re-exporting under their original names so neither test file's imports needed to change. (2) `lib/vocabSeed.ts`'s `STARTER_BRANDS` was exported but never consumed externally (unlike STARTER_COLORS/MATERIALS/DEPARTMENTS, which the Task 11 test files import) — de-exported it since it's only used internally by `seedStarterVocabulary`. Both fixed at the root, no suppressions added.

**Stryker mutation testing — BLOCKED, pre-existing environment issue, not a regression**: `npx stryker run` scoped to the new logic files (lib/vocabResolver.ts, lib/vocabSeed.ts, app/api/{colors,materials,departments}/route.ts) crashes with `ChildProcessCrashedError: ... SIGSEGV` during the initial dry run, alongside a `test.poolOptions was removed in Vitest 4` deprecation warning and a stryker-setup.js.map ENOENT. Verified this is NOT caused by this feature: the identical crash reproduces when Stryker mutates only `lib/brands.ts` (pre-existing, shipped in PR #12, untouched by this feature) with an otherwise-unmodified `stryker.conf.json`. This is a pre-existing Stryker/Vitest 4 compatibility break in this repo/worktree's environment, unrelated to any file this feature touches. `stryker.conf.json` was restored to its original committed state (byte-for-byte diffed) after the investigation — no config change shipped. Mutation coverage for this feature's logic is not available until this pre-existing tooling incompatibility is fixed separately; regular vitest coverage (95%+ statements/lines) and the fallow/eslint/tsc/e2e passes above stand in as the harden-phase evidence for this run.

## Blocked / open
(none yet)
