# Steps: Reseller Seeded Vocabularies

## Prerequisites
None. The feature extends the existing multi-tenant infrastructure and vocabulary pattern (established by PR #12 `clothing_brands`) without requiring external setup or prior feature completion.

## Implementation steps

### Step 1a: Create migration DDL for clothing_colors/clothing_materials/clothing_departments tables
**What**: Create migration `012_clothing_vocabularies.sql` that creates three new tables `clothing_colors`, `clothing_materials`, `clothing_departments` (matching `clothing_brands`' schema). Use simplified id format `lower(hex(randomblob(16)))` (32 hex chars, no UUIDv4 version-nibble CHECK constraint) instead of the UUIDv4 shape used by clothing_brands, eliminating unnecessary correctness risk. Also add a new index `idx_clothing_details_tenant` on `clothing_details(tenant_id)`. DDL only — no seeding or backfilling in this step. Register the migration in `lib/db.ts`'s `VERSIONED_MIGRATIONS` array as `{ version: 12, file: '012_clothing_vocabularies.sql' }` (the last entry there is version 11 at line 60) — the migration file is inert until this array references it.
**Files**: `data/migrations/012_clothing_vocabularies.sql`, `lib/db.ts`
**Test**: Trigger migration against a scratch DB by running `npx vitest run` with `BOOKSELLER_DB_PATH` pointed at a throwaway file, then inspect it: `sqlite3 "file:<scratch-path>?mode=ro" ".schema clothing_colors"` should show the table exists with `id`, `tenant_id`, `canonical_name` columns; same for materials and departments; verify `idx_clothing_details_tenant` index exists via `.indices`. Verify `lib/db.ts` console-logs "Applied migration 012_clothing_vocabularies.sql (user_version → 12)" on first run against a fresh scratch DB.
**Depends on**: None
**Parallelizable**: No

### Step 1b: Seed clothing_colors/clothing_materials/clothing_departments for existing tenants
**What**: Add INSERT OR IGNORE ... SELECT ... CROSS JOIN seed blocks to migration 012 for the three new tables only (14+14+5 = 33 values total). Each block seeds every existing tenant with the same starter values. Every apostrophe in a seed literal must be doubled for SQL escaping (e.g., "Levi's" becomes the SQL literal 'Levi''s'; "Men's" becomes 'Men''s'; "Kids'" becomes 'Kids'''). Do NOT backfill clothing_brands in this step.
**Files**: `data/migrations/012_clothing_vocabularies.sql` (same file as 1a, distinct conceptual sub-step)
**Test**: Run `npx vitest run` with scratch DB; verify initial seeding: `sqlite3 "file:<scratch-path>?mode=ro" "SELECT COUNT(*) FROM clothing_colors WHERE tenant_id = <tenant-id>;"` should return 14; same for materials (14) and departments (5). Idempotency (FR9): extract and re-run ONLY the three INSERT OR IGNORE blocks a second time against the same already-migrated scratch DB (e.g., copy the three blocks to a temporary file and run `sqlite3 <scratch-path> < temp-inserts.sql`) and confirm row counts are unchanged; then run `SELECT DISTINCT canonical_name FROM clothing_colors WHERE tenant_id = ? ORDER BY canonical_name;` and verify exactly 14 colors (no duplicates added by second run).
**Depends on**: Step 1a
**Parallelizable**: No

### Step 1c: Backfill clothing_brands with starter brands for existing tenants
**What**: Add INSERT OR IGNORE ... SELECT ... CROSS JOIN seed block to migration 012 for clothing_brands table (25 values). This retrofits an already-shipped, potentially-live production table, so it's called out as a distinct step (different risk profile than the brand-new empty tables in 1a/1b). Every apostrophe in a seed literal must be doubled for SQL escaping (e.g., "J.Crew" and "Levi's" become 'J.Crew' and 'Levi''s').
**Files**: `data/migrations/012_clothing_vocabularies.sql` (same file as 1a/1b, distinct conceptual sub-step)
**Test**: Run `npx vitest run` with scratch DB; verify backfill: `sqlite3 "file:<scratch-path>?mode=ro" "SELECT COUNT(*) FROM clothing_brands WHERE tenant_id = <tenant-id>;"` should return 25 (not 0, confirming seeding happened); verify no duplicates and correct ordering via `SELECT DISTINCT canonical_name FROM clothing_brands WHERE tenant_id = ? ORDER BY canonical_name;`.
**Depends on**: Step 1a
**Parallelizable**: No

### Step 2: Create shared seed helper for future tenants
**What**: Create `lib/vocabSeed.ts` with a `seedStarterVocabulary(tenantId: string)` function and four const arrays (`STARTER_COLORS`, `STARTER_MATERIALS`, `STARTER_DEPARTMENTS`, `STARTER_BRANDS`) holding the exact starter values that the migration uses. This is the JS-side source of truth; the migration's SQL literals are a frozen snapshot.
**Files**: `lib/vocabSeed.ts`
**Test**: Import the module in a test; verify the four arrays have correct lengths (14, 14, 5, 25) and spot-check exact values ("Gray", "Polyester", "Kids'", "Nike" must be present); call `seedStarterVocabulary(testTenantId)` in a test database transaction and verify no errors thrown and all four tables populated for that tenant.
**Depends on**: Step 1a (migration must exist)
**Parallelizable**: Yes

### Step 3: Wire seeding into tenant creation
**What**: Update `lib/tenantAuth.ts` — `createTenant()` function to wrap the existing `INSERT INTO tenants` and new `seedStarterVocabulary(tenantId)` call in one `db.transaction()` block, ensuring every new tenant atomically gets its starter vocabulary.
**Files**: `lib/tenantAuth.ts`
**Test**: Call `createTenant()` (or exercise the signup route) with a new tenant; immediately query `SELECT COUNT(*) FROM clothing_colors WHERE tenant_id = ?` for that tenant and verify the count is exactly 14 (not 0); verify `DuplicateEmailError` and `WeakPasswordError` still propagate correctly out of the transaction.
**Depends on**: Step 2
**Parallelizable**: No

### Step 4: Create shared vocab-resolver factory plus color/material/department instantiations
**What**: Create `lib/vocabResolver.ts` exporting a factory function `createVocabResolver(tableName: string)` that returns an object with three methods: `resolveCanonical(tenantId, rawValue)`, `validateInput(value)`, and `selectCanonical(tenantId, canonicalName)`. The factory is a shared abstraction of the color/material/department pattern; colors/materials/departments are optional fields (unlike brand which is required), so `validateInput` for all three must treat empty string `""` and `undefined` as VALID. Then create `lib/colors.ts`, `lib/materials.ts`, `lib/departments.ts` as thin instantiations: each calls the factory with its tableName and re-exports the returned functions with domain-specific names (e.g., `resolveCanonicalColor`, `validateColorInput`, `selectCanonicalColor`). Handle `SQLITE_CONSTRAINT_UNIQUE` race on INSERT by re-selecting and returning the winning row's canonical_name.
**Files**: `lib/vocabResolver.ts`, `lib/colors.ts`, `lib/materials.ts`, `lib/departments.ts`
**Test**: Unit test: verify `resolveCanonicalColor(tenantId, "  gray ")` when "Gray" exists returns "Gray" (no new row); call with "Lavender" (not seeded) and verify new row inserted and trimmed value returned; simulate two concurrent `resolveCanonicalColor` calls with identical new value and verify no exception and exactly one row. Verify `validateColorInput("")` returns valid, `validateColorInput(undefined)` returns valid (optional field, handles undefined not just empty string), `validateColorInput("x".repeat(256))` returns invalid (exceeds 255 chars), `validateColorInput("blue")` returns valid. Repeat the same validation tests (including undefined case) for `validateMaterialInput` and `validateDepartmentInput`. Verify `selectCanonicalColor(tenantId, "Gray")` returns the row, calling with non-existent name returns null. Test concurrent race condition and ≤255 character limit enforcement across all three functions.
**Depends on**: Step 1a
**Parallelizable**: Yes

### Step 5: Create GET /api/colors, /api/materials, /api/departments endpoints
**What**: Create three endpoints as direct copies of `app/api/brands/route.ts` pattern: `app/api/colors/route.ts`, `app/api/materials/route.ts`, `app/api/departments/route.ts`. Each authenticates via `requireTenant()`, queries its table (`SELECT id, canonical_name FROM clothing_colors WHERE tenant_id = ? ORDER BY canonical_name COLLATE NOCASE LIMIT 200`), and returns `{ colors: [...] }` (or materials/departments as appropriate) JSON. These endpoints are raw data-access layers; they do not import or depend on the lib resolver functions.
**Files**: `app/api/colors/route.ts`, `app/api/materials/route.ts`, `app/api/departments/route.ts`
**Test**: Call each endpoint with authenticated tenant; verify response shape matches `{ colors: Array<{ id, canonical_name }> }` (and materials/departments equivalents); verify all 14 seeded colors present and ordered case-insensitively; verify second tenant cannot see first tenant's rows; verify unauthenticated call returns 401 or redirect-equivalent.
**Depends on**: Step 1a (tables must exist)
**Parallelizable**: Yes

### Step 6: Create reusable VocabCombobox component
**What**: Create `components/VocabCombobox.tsx` that generalizes `BrandCombobox.tsx`'s filtering/ranking/keyboard logic: parameterize by `endpoint` (e.g., `/api/colors`), `responseKey` (`colors`), `suggestionField` (`color`), `label` (`Color`), `required` (default false), `maxLength`; implement case-insensitive substring filtering, frequency-ranking from `fetchFieldSuggestions`, "Add \"{typed}\" as new {label}" trailing option when no exact match, full ARIA keyboard support (ArrowDown/Up, Enter, Escape), and raw-keystroke commit-on-every-keystroke to preserve Playwright `.fill()` compatibility.
**Files**: `components/VocabCombobox.tsx`
**Test**: Component test: render with endpoint `/api/colors`; type "bl" and verify filtered list shows "Black", "Blue" (NOT "Multicolor" — "Multicolor" does not contain the substring "bl", this was an error in the original test description); type "Lavender" (not seeded) and verify "Add 'Lavender' as a new Color" appears as last option; verify ArrowDown twice then Enter selects the second item and fires `onChange`; verify Escape closes dropdown; verify keystroke-on-keystroke fires `onChange` (for `.fill()` compat).
**Depends on**: Step 5 (endpoints must exist and return data)
**Parallelizable**: Yes

### Step 7: Wire resolve and validation into clothing item creation
**What**: Update `app/api/items/route.ts` — clothing item creation branch: replace inline `typeof` checks with calls to `validateColorInput()`, `validateMaterialInput()`, `validateDepartmentInput()` in field validation; after `invalidFieldsResponse()` gate passes, add three resolve calls (only if field non-empty): `if (fields.color) fields.color = resolveCanonicalColor(tenantId, fields.color)` (and same for material, department) before `insertClothingRecord()`.
**Files**: `app/api/items/route.ts`
**Test**: Submit clothing form with color "gRaY" (seeded as "Gray") and verify database stores `color = "Gray"`; submit with new color "Lavender" and verify new `clothing_colors` row created and item stores "Lavender"; submit with invalid color (256 chars) and verify 422 validation error; submit with empty color and verify item created with NULL color.
**Depends on**: Step 4 (lib helpers exist)
**Parallelizable**: Yes

### Step 8: Replace datalist inputs with VocabCombobox in AddClothingForm
**What**: Update `components/AddClothingForm.tsx` — remove three `<input list="color-options">` / `<datalist>` blocks (lines ~249–292) and replace with `<VocabCombobox endpoint="/api/colors" responseKey="colors" suggestionField="color" label="Color" maxLength={255} />` (and equivalent for material, department with `required={false}`); leave brand, size, condition, measurements, acquisition fields untouched.
**Files**: `components/AddClothingForm.tsx`
**Test**: Render form; verify three fields render as comboboxes (test DOM role="combobox"); verify existing Playwright E2E tests that `.fill()` color/material/department inputs still pass unchanged; verify brand, size, condition fields are visually and functionally unchanged.
**Depends on**: Steps 6, 7 (VocabCombobox must exist and items route must handle canonicalization)
**Parallelizable**: No

### Step 9: Write API endpoint tests for vocabulary endpoints
**What**: Create `tests/api/colors.test.ts`, `tests/api/materials.test.ts`, `tests/api/departments.test.ts` (mirroring `tests/api/brands.test.ts`): test successful GET with correct response shape and 200 rows per endpoint, test tenant-scoping (second tenant sees only own rows), test unauthenticated 401, test result ordering (case-insensitive), test 200-row cap.
**Files**: `tests/api/colors.test.ts`, `tests/api/materials.test.ts`, `tests/api/departments.test.ts`
**Test**: Run `npm run test tests/api/colors.test.ts tests/api/materials.test.ts tests/api/departments.test.ts`; all should pass; verify coverage thresholds (85/80/85/85) met for the three route files.
**Depends on**: Step 5 (endpoints exist)
**Parallelizable**: Yes

### Step 10: Write lib helper tests for vocabulary resolvers
**What**: Create `lib/__tests__/vocabResolver.test.ts` (matching this repo's actual test-file convention — `lib/brands.ts` itself has no separate lib-level test file, only `tests/api/brands.test.ts`, but this feature introduces a genuinely new shared factory that deserves direct unit coverage): test the `createVocabResolver` factory plus all three instantiations (`resolveCanonicalColor`/`Material`/`Department`) with existing/new/whitespace-padded values, case-insensitive lookup, concurrent race condition (two calls with same new value result in one row), `validateXInput()` with valid/invalid/empty/undefined/too-long inputs across all three, and `selectCanonicalX()` missing-value behavior.
**Files**: `lib/__tests__/vocabResolver.test.ts`
**Test**: Run `npx vitest run lib/__tests__/vocabResolver.test.ts`; all should pass; verify coverage thresholds met for `lib/vocabResolver.ts`, `lib/colors.ts`, `lib/materials.ts`, `lib/departments.ts`.
**Depends on**: Step 4 (lib helpers exist)
**Parallelizable**: Yes

### Step 11: Write VocabCombobox component tests
**What**: Create `components/__tests__/VocabCombobox.test.tsx` (mirroring `components/__tests__/BrandCombobox.test.tsx`): test rendering, test case-insensitive substring filtering, test "Add \"{typed}\"" option appearance when no exact match, test keyboard navigation (ArrowDown/Up, Enter, Escape), test `onChange` fires on selection, test raw keystroke-on-keystroke commit behavior (for Playwright `.fill()` compat).
**Files**: `components/__tests__/VocabCombobox.test.tsx`
**Test**: Run `npm run test components/__tests__/VocabCombobox.test.tsx`; all should pass; verify coverage thresholds met for the component.
**Depends on**: Step 6 (component exists)
**Parallelizable**: Yes

### Step 12: Verify end-to-end form submission and vocabulary deduplication
**What**: Run or write Playwright E2E tests that submit the clothing intake form with a new color/material/department value, verify the item is created with the canonical (resolved) value in the database, verify the new vocabulary entry is added to its table, and verify re-submission with a case variant (e.g., "GRAY" vs seeded "Gray") does not create a duplicate vocabulary row.
**Files**: `tests/e2e/clothing-flow.spec.ts` (existing file — add new tests here, matching this repo's actual e2e path convention)
**Test**: Run the E2E test suite; verify form submission end-to-end works, database stores canonical values, vocabulary deduplication (case-insensitive UNIQUE constraint) prevents duplicates, and existing Playwright `.fill()` helpers on color/material/department fields still work unchanged.
**Depends on**: Steps 8, 7 (form updated, route wired)
**Parallelizable**: No

### Step 13: Run full test suite and coverage report
**What**: Execute the complete Vitest test suite (`npm run test`) plus generate coverage report (`npm run test:coverage`), confirming (a) no regression in existing brand/size/condition/book-related tests (AC16) and (b) no repo-wide coverage regression (AC17).
**Files**: None (suite execution only)
**Test**: Run `npm run test` and verify all tests pass; run `npm run test:coverage` and verify coverage thresholds maintained; spot-check that coverage for lib/brands, lib/sizes, lib/conditions, and lib/books remains unchanged; confirm no new uncovered branches introduced in the vocabulary implementation code.
**Depends on**: Steps 1a, 1b, 1c, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 (all previous steps)
**Parallelizable**: No

## Rollback plan
All steps are reversible via git:
- Steps 1a–1c: Migration file (`data/migrations/012_clothing_vocabularies.sql`). There is no separate migrate command to "undo" — deleting the scratch DB file (never the real `data/inventory.db`) and letting `lib/db.ts` recreate + re-migrate from scratch on next access is the reset path for a throwaway test database. **IMPORTANT: migration 012 auto-applies via `lib/db.ts`'s module-init runner on ANY database access, not just scratch databases used in tests. There is no down-migration mechanism if 012 ships with a real defect and has already auto-applied to a real (non-scratch) database. This is a pre-existing limitation of the whole migration system, not unique to this feature.**
- Steps 2, 4, 6: Drop new lib/component files (`lib/vocabSeed.ts`, `lib/vocabResolver.ts`, `lib/colors.ts`, `lib/materials.ts`, `lib/departments.ts`, `components/VocabCombobox.tsx`).
- Steps 3, 7, 8: Revert edits to `lib/tenantAuth.ts`, `app/api/items/route.ts`, and `components/AddClothingForm.tsx` using `git checkout`.
- Step 5: Drop endpoint route files (`app/api/colors/route.ts`, `app/api/materials/route.ts`, `app/api/departments/route.ts`).
- Steps 9–12: Drop test files.

Full reset: `git checkout .` (plus deleting any scratch DB file created during manual verification — never `data/inventory.db`).
