# Steps: Constrained Brand, Size, and ISBN Fields on Add-Item Forms

## Prerequisites
None.

## Implementation steps

### Step 1: Add ISBN checksum validation functions to lib/isbn.ts
**What**: Extract and add checksum computation and validation for ISBN-10 and ISBN-13 formats.
**Files**: `lib/isbn.ts`
**Test**: New functions exported; `validateIsbnChecksum('0306406156')` returns `{ valid: true }` and `validateIsbnChecksum('0306406157')` returns `{ valid: false, reason: 'checksum' }`.
**Depends on**: none
**Parallelizable**: Yes

### Step 2: Add SIZE_SYSTEMS and size validation to lib/clothing.ts
**What**: Add constants for closed-vocabulary size systems (letter, shoe, numeric_waist_inseam) and validation functions.
**Files**: `lib/clothing.ts`
**Test**: `SIZE_SYSTEMS` object exists with all three systems; `validateSizeSystem('letter')` returns true and `validateSizeSystem('invalid')` returns false.
**Depends on**: none
**Parallelizable**: Yes

### Step 3: Create and register migration 011_clothing_brand_and_size_system
**What**: Create the migration SQL file adding tables for canonical brands (no aliases, per plan.md) plus size_system column to clothing_details; then register version 11 entry in VERSIONED_MIGRATIONS array in lib/db.ts.
**Files**: `data/migrations/011_clothing_brand_and_size_system.sql`, `lib/db.ts`
**Test**: Migration file exists with valid SQL syntax; running the migration against a fresh sqlite3 database (or via the app's own migration runner) successfully creates the brands table with the correct schema and size_system column; `VERSIONED_MIGRATIONS` array contains `{ version: 11, file: '011_clothing_brand_and_size_system.sql' }`.
**Depends on**: none
**Parallelizable**: Yes

### Step 4: Create lib/brands.ts with resolveCanonicalBrand helper
**What**: Implement canonical-name-only (no aliases) case-insensitive lookup of brand input, inserting new canonical entries for unmatched values and handling concurrent submissions.
**Files**: `lib/brands.ts`
**Test**: Function imports cleanly; handles matching canonical names case-insensitively, creates new entries for unmatched values, and handles concurrent new-brand submissions (race condition: only one succeeds, others reuse the first); test with mock DB context and real concurrent scenarios.
**Depends on**: Step 3 (schema must be registered/applied)
**Parallelizable**: Yes

### Step 5: Create app/api/brands/route.ts GET endpoint
**What**: Return tenant-scoped list of canonical brands, ordered by canonical name and ranked by frequency history from existing `fetchFieldSuggestions('brand')`.
**Files**: `app/api/brands/route.ts`
**Test**: GET request returns 200 with `{ brands: [...] }` shape; ordering by canonical_name COLLATE NOCASE verified; frequency-ranked ordering confirmed (most-used brands appear first in suggestions).
**Depends on**: Step 3 (migration registered)
**Parallelizable**: Yes

### Step 6: Add ISBN checksum validation to app/api/items/route.ts (book branch)
**What**: Call validateIsbnChecksum before lookupISBN in the POST /api/items book flow; return 422 on checksum failure (with fields: ['isbn']).
**Files**: `app/api/items/route.ts`
**Test**: POST with checksum-invalid ISBN returns 422 with correct error shape distinguishing checksum errors from shape errors; checksum-valid ISBN proceeds to lookup; invalid shape still returns appropriate error.
**Depends on**: Step 1
**Parallelizable**: No

### Step 7a: Add brand canonicalization to app/api/items/route.ts (clothing branch)
**What**: Call resolveCanonicalBrand for brand input in the clothing branch, handling the canonical-name-only match-or-create flow and race conditions.
**Files**: `app/api/items/route.ts`
**Test**: POST with unmatched brand creates new canonical entry and persists it; concurrent new-brand submissions race safely (only one new entry created, both requests use it); cross-tenant brand isolation verified (tenant A's brands don't appear in tenant B's view).
**Depends on**: Step 3, Step 4
**Parallelizable**: No

### Step 7b: Add size_system and size_label vocabulary validation to app/api/items/route.ts (clothing branch)
**What**: Validate size_system enum and size_label against the chosen system's vocabulary (including numeric_waist_inseam regex `^\d{1,3}x\d{1,3}$`).
**Files**: `app/api/items/route.ts`
**Test**: POST with invalid size_system returns 422 with fields: ['size_system']; size_label validated against system vocab (letter accepts [XS-XL], shoe accepts [shoe sizes], numeric_waist_inseam accepts two-number format); invalid size_label returns 422 with fields: ['size_label'].
**Depends on**: Step 2, Step 3
**Parallelizable**: No

### Step 8: Create components/BrandCombobox.tsx
**What**: Hand-rolled ARIA combobox filtering canonical brand list by substring (case-insensitive, canonical-name-only matching), ranked by frequency history; renders "Add '<value>' as new brand" option when no match.
**Files**: `components/BrandCombobox.tsx`
**Test**: Component renders; fetch from GET /api/brands succeeds and suggestions are ranked by frequency (most-used first); filtering works for substring matches; "Add new" option appears for unmatched input; keyboard-only operation supported (arrow keys, Enter, Escape).
**Depends on**: Step 5
**Parallelizable**: Yes

### Step 9: Create components/SizeSystemPicker.tsx
**What**: Small select component offering "Free text" and closed-vocabulary options (Letter, Shoe, Numeric waist × inseam), defaults to free text.
**Files**: `components/SizeSystemPicker.tsx`
**Test**: Component renders with all four options; onChange callback fires with correct size_system value; initial value defaults to null/"Free text".
**Depends on**: Step 2
**Parallelizable**: Yes

### Step 10: Update AddBookForm.tsx with ISBN checksum validation
**What**: Call validateIsbnChecksum on blur/change before lookupIsbn; add FieldError under ISBN input displaying both shape and checksum error messages; book form never renders a size field.
**Files**: `components/AddBookForm.tsx`
**Test**: Typing invalid checksum ISBN shows checksum error; clicking away does not trigger network lookup; valid ISBN still triggers lookup; leaving ISBN blank allows manual submission; form contains no size field.
**Depends on**: Step 1
**Parallelizable**: Yes

### Step 11a: Wire BrandCombobox into AddClothingForm.tsx
**What**: Replace bare `<input list>` + `<datalist>` brand field with BrandCombobox component.
**Files**: `components/AddClothingForm.tsx`
**Test**: BrandCombobox renders in place of datalist; filtering, selection, and add-new-brand flow work end-to-end; form submission with selected brand succeeds.
**Depends on**: Step 8
**Parallelizable**: No

### Step 11b: Wire SizeSystemPicker into AddClothingForm.tsx with conditional size-field rendering
**What**: Add SizeSystemPicker; conditionally render free-text or closed-vocabulary size field based on picker state (numeric_waist_inseam shows two-number inputs, not a select).
**Files**: `components/AddClothingForm.tsx`
**Test**: SizeSystemPicker defaults to free-text and renders a free-text size input; selecting Letter/Shoe shows appropriate field; numeric_waist_inseam shows two separate number inputs; switching systems clears stale/invalid size_label values.
**Depends on**: Step 9
**Parallelizable**: No

### Step 12: Extend tests/api/isbn.test.ts with checksum cases
**What**: Add test cases for ISBN-10 with valid/invalid check digit, ISBN-13 with valid/invalid check digit, X check character for ISBN-10, and API-level distinction between shape vs. checksum 422 responses.
**Files**: `tests/api/isbn.test.ts`
**Test**: All new test cases pass; checksum validation distinguishes shape vs. checksum errors; POST /api/items book flow returns correct error shape for each case; API-level tests (not just pure function tests) verify the 422 checksum-error path.
**Depends on**: Step 1, Step 6
**Parallelizable**: Yes

### Step 13: Create tests/api/brands.test.ts
**What**: Test canonical-name-only matching (case-insensitivity), brand creation on unmatched submit, cross-tenant brand isolation, concurrent new-brand race handling, and GET /api/brands response shape with frequency ranking.
**Files**: `tests/api/brands.test.ts`
**Test**: All test cases pass; canonical matching works case-insensitively; new brands inserted correctly; concurrent submissions race safely; tenants cannot see each other's brands; frequency ranking present in GET response.
**Depends on**: Step 4, Step 5
**Parallelizable**: Yes

### Step 14a: Extend E2E tests for combobox interaction
**What**: Add tests for BrandCombobox filtering, selection, add-new-brand workflow, and keyboard-only operation (arrow keys, Enter, Escape).
**Files**: `tests/e2e/clothing-flow.spec.ts`
**Test**: Combobox filtering and selection works end-to-end; "Add new brand" path succeeds; keyboard-only operation supported and tested.
**Depends on**: Step 8, Step 11a
**Parallelizable**: No

### Step 14b: Extend E2E tests for size-system picker behavior
**What**: Add tests for SizeSystemPicker toggle between Free text and closed-vocabulary, stale-value handling (typing a size under Free text, then switching systems, confirms the field doesn't silently keep an invalid value).
**Files**: `tests/e2e/clothing-flow.spec.ts`
**Test**: Size-system picker toggle switches field mode correctly; stale values are cleared when switching systems; numeric_waist_inseam two-number input works; form submission includes correct size data.
**Depends on**: Step 9, Step 11b
**Parallelizable**: No

### Step 14c: Confirm book flow never renders size field and canonical brand persists end-to-end
**What**: Add E2E test confirming AddBookForm never renders a size field and that canonical brand persists through the full clothing form submission flow.
**Files**: `tests/e2e/clothing-flow.spec.ts`, `tests/e2e/book-flow.spec.ts`
**Test**: Book form never renders a size field; clothing form submission persists the canonical brand (verified in DB or returned in get-item response); canonical brand appears in subsequent listings.
**Depends on**: Step 10, Step 11a, Step 11b
**Parallelizable**: No

**Implementation note**: Steps 6, 7a, and 7b all modify `app/api/items/route.ts`. Although their formal dependencies allow parallel execution in theory, these steps should be implemented sequentially (not dispatched to parallel subagents) to avoid colliding edits to the same file.

## Rollback plan
- Steps 1–2: Edit lib/isbn.ts and lib/clothing.ts to remove new functions (no schema impact, safe to revert).
- Step 3: Delete `data/migrations/011_clothing_brand_and_size_system.sql` and remove the version-11 entry from `VERSIONED_MIGRATIONS` in lib/db.ts; database reverts on next startup when missing migration is detected.
- Steps 4–5: Delete lib/brands.ts and app/api/brands/route.ts.
- Steps 6–7: Edit app/api/items/route.ts to remove ISBN checksum, brand canonicalization, and size validation calls.
- Steps 8–9: Delete components/BrandCombobox.tsx and components/SizeSystemPicker.tsx.
- Steps 10–11: Revert AddBookForm.tsx and AddClothingForm.tsx to prior state.
- Steps 12–14: Delete new test files; revert extended test files to prior state.

All steps reversible via git.

**Migration irreversibility**: Migrations in this codebase follow the established forward-only convention (no down-migrations exist for any of `001`–`010` either), so rolling back this step by deleting the file and entry is consistent with existing project practice.
