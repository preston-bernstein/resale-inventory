# Tasks: Constrained Brand, Size, and ISBN Fields on Add-Item Forms

Generated from: docs/reseller-form-autocomplete/ on 2026-07-17

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Add ISBN checksum validation functions to lib/isbn.ts
**Status**: [x] done
**Files**: lib/isbn.ts
**Test**: `validateIsbnChecksum('0306406156')` returns `{ valid: true }`; `validateIsbnChecksum('0306406157')` returns `{ valid: false, reason: 'checksum' }`
**Depends on**: none
**Parallelizable**: yes
**Notes**: steps.md's literal test string '0306406156' was a typo (correct check digit for that prefix is 2, not 6 — real valid ISBN-10 is '0306406152'); agent correctly implemented the real algorithm rather than weakening it to force the typo'd string to pass. Verified against known ISBN-10/13 test vectors.

### Task 2: Add SIZE_SYSTEMS and size validation to lib/clothing.ts
**Status**: [x] done
**Files**: lib/clothing.ts
**Test**: `SIZE_SYSTEMS` exists with all three systems; `validateSizeSystem('letter')` true, `validateSizeSystem('invalid')` false
**Depends on**: none
**Parallelizable**: yes
**Notes**: Fixed post-hoc: agent's validateSizeAgainstSystem used `as any` (2 eslint no-explicit-any errors) — corrected to `as readonly string[]`, re-linted clean.

### Task 3: Create and register migration 011_clothing_brand_and_size_system
**Status**: [x] done
**Files**: data/migrations/011_clothing_brand_and_size_system.sql, lib/db.ts
**Test**: Migration creates clothing_brands table (canonical-name-only, no aliases per plan.md) + clothing_details.size_system column against a real scratch DB; VERSIONED_MIGRATIONS contains version 11 entry
**Depends on**: none
**Parallelizable**: yes
**Notes**: Content verified byte-for-byte against reviewed plan.md SQL.

### Task 4: Create lib/brands.ts with resolveCanonicalBrand helper
**Status**: [x] done
**Files**: lib/brands.ts
**Test**: Canonical-name-only case-insensitive match-or-create; concurrent new-brand submissions race safely (SQLITE_CONSTRAINT_UNIQUE caught, re-SELECT used)
**Depends on**: Task 3
**Parallelizable**: yes
**Notes**: Verified: lint+typecheck clean. validateBrandInput + resolveCanonicalBrand implemented per plan.md contract.

### Task 5: Create app/api/brands/route.ts GET endpoint
**Status**: [x] done
**Files**: app/api/brands/route.ts
**Test**: GET returns 200 `{ brands: [...] }`, ordered canonical_name COLLATE NOCASE, LIMIT 200, frequency-ranked
**Depends on**: Task 3
**Parallelizable**: yes
**Notes**: Verified: lint+typecheck clean. No aliases/POST/frequency-ranking per plan.md (ranking merge happens client-side in BrandCombobox, a later task).

### Task 6: Add ISBN checksum validation to app/api/items/route.ts (book branch)
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: Checksum-invalid ISBN returns 422 distinguishing shape vs checksum; checksum-valid proceeds to lookup
**Depends on**: Task 1
**Parallelizable**: no
**Notes**: Verified: lint+typecheck clean. Ordering (checksum before normalizeISBN) confirmed.

### Task 7a: Add brand canonicalization to app/api/items/route.ts (clothing branch)
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: Unmatched brand creates new canonical entry; concurrent race handled; cross-tenant isolation verified
**Depends on**: Task 3, Task 4
**Parallelizable**: no
**Notes**: Verified: lint+typecheck clean. Only clothing-branch brand code touched.

### Task 7b: Add size_system and size_label vocabulary validation to app/api/items/route.ts (clothing branch)
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: Invalid size_system returns 422; size_label validated against system vocab (loosened numeric_waist_inseam regex ^\d{1,3}x\d{1,3}$)
**Depends on**: Task 2, Task 3
**Parallelizable**: no
**Notes**: Verified: lint+typecheck clean. ClothingFields/insert/select all updated for size_system.

### Task 8: Create components/BrandCombobox.tsx
**Status**: [x] done
**Files**: components/BrandCombobox.tsx
**Test**: Renders; fetches GET /api/brands + fetchFieldSuggestions('brand') itself; substring filter; frequency-ranked; "Add new brand" option sets confirmed_new; keyboard-only operable
**Depends on**: Task 5
**Parallelizable**: yes
**Notes**: Verified: lint+typecheck clean.

### Task 9: Create components/SizeSystemPicker.tsx
**Status**: [x] done
**Files**: components/SizeSystemPicker.tsx
**Test**: Renders 4 options (Free text/Letter/Shoe/Numeric); onChange fires correct size_system; defaults to null/Free text
**Depends on**: Task 2
**Parallelizable**: yes
**Notes**: Verified: lint+typecheck clean.

### Task 10: Update AddBookForm.tsx with ISBN checksum validation
**Status**: [x] done
**Files**: components/AddBookForm.tsx
**Test**: Invalid checksum shows distinct error, clears stale isbnLookupMsg, no network fired; valid ISBN still looks up; blank ISBN allows manual submission
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: Verified: lint+typecheck clean. Ordering/state/message-clearing requirements all met.

### Task 11a: Wire BrandCombobox into AddClothingForm.tsx
**Status**: [x] done
**Files**: components/AddClothingForm.tsx
**Test**: BrandCombobox replaces datalist; filtering/selection/add-new flow works; typed-but-unselected text still commits (existing e2e .fill() helper keeps working)
**Depends on**: Task 8
**Parallelizable**: no
**Notes**: Verified: lint+typecheck clean.

### Task 11b: Wire SizeSystemPicker into AddClothingForm.tsx with conditional size-field rendering
**Status**: [x] done
**Files**: components/AddClothingForm.tsx
**Test**: Picker defaults free-text; Letter/Shoe show select; numeric_waist_inseam shows two number inputs; switching systems clears stale size_label
**Depends on**: Task 9
**Parallelizable**: no
**Notes**: Fixed post-hoc regression: null-branch used a bare Fragment, so the "Size *" label and SizeSystemPicker's select shared the same parent div — the existing test helper's label-to-sibling-input walk (querySelector, first-match-in-doc-order) grabbed the wrong element, breaking 9 existing AddClothingForm tests. Wrapped that branch in its own div (matching the other two branches' convention). Full suite back to 1743/1743 passing.

### Task 12: Extend tests/api/isbn.test.ts with checksum cases
**Status**: [x] done
**Files**: tests/api/isbn.test.ts
**Test**: ISBN-10/13 valid+invalid checksum cases incl. X check char; API-level shape-vs-checksum 422 distinction
**Depends on**: Task 1, Task 6
**Parallelizable**: yes
**Notes**: Verified: all 27 tests pass. Fixed a pre-existing test broken by our checksum gate: AddBookForm.test.tsx's "Lookup failed" test used ISBN '123' (shape-invalid), which our new client-side gate now blocks before the network call it was testing — updated to a checksum-valid ISBN (0306406152) so it still reaches the mocked fetch.

### Task 13: Create tests/api/brands.test.ts
**Status**: [x] done
**Files**: tests/api/brands.test.ts
**Test**: Canonical case-insensitive matching, brand creation on unmatched submit, cross-tenant isolation, concurrent-race handling, GET /api/brands shape+ranking
**Depends on**: Task 4, Task 5
**Parallelizable**: yes
**Notes**: Verified: all 11 tests pass. Full suite: fixed a second cross-cutting regression — tests/api/tenant-isolation.test.ts hardcoded user_version==10, needed bumping to 11 for our new migration. Full suite now 1743/1743 passing (22 skipped). One unrelated pre-existing failure noted separately: tests/e2e-deployed/smoke.spec.ts is Playwright-only syntax not excluded from vitest discovery (vitest.config.ts excludes tests/e2e/** but not tests/e2e-deployed/**) — added in the prior commit before this feature, out of scope to fix here.

### Task 14a: Extend E2E tests for combobox interaction
**Status**: [x] done
**Files**: tests/e2e/clothing-flow.spec.ts
**Test**: Combobox filtering/selection/add-new works end-to-end; keyboard-only operation tested
**Depends on**: Task 8, Task 11a
**Parallelizable**: no
**Notes**: Verified: 4 new e2e tests pass (partial-match select, add-new-brand, keyboard ArrowDown+Enter, Escape).

### Task 14b: Extend E2E tests for size-system picker behavior
**Status**: [x] done
**Files**: tests/e2e/clothing-flow.spec.ts
**Test**: Picker toggle switches field mode; stale values cleared on system switch; numeric_waist_inseam two-input works
**Depends on**: Task 9, Task 11b
**Parallelizable**: no
**Notes**: Verified: 5 new e2e tests pass (default free-text, letter select, numeric two-input incl. detail-page verification, stale-value clearing).

### Task 14c: Confirm book flow never renders size field and canonical brand persists end-to-end
**Status**: [x] done
**Files**: tests/e2e/clothing-flow.spec.ts, tests/e2e/book-flow.spec.ts
**Test**: Book form never renders size field; clothing form submission persists canonical brand, verified in subsequent listing
**Depends on**: Task 10, Task 11a, Task 11b
**Parallelizable**: no
**Notes**: Verified: 2 new e2e tests pass (book form has no size field; cross-submission canonical-casing persistence via two real HTTP submits).

## Blocked / open
(populated during implementation)
