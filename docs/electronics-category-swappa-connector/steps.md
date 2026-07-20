# Steps: Electronics Category + Swappa Connector

## Prerequisites
- None. This feature is additive and requires no prior setup beyond the existing development environment.

## Implementation steps

### Step 0: Verify live schema and back up database
**What**: SSH to the desktop (`ssh desktop-agent`), run `sudo -u resale-inventory sqlite3 /home/resale-inventory/resale-inventory/data/inventory.db ".schema items"` to confirm the real current column order and CHECKs match what migration 014 assumes, and take a manual backup copy of `data/inventory.db` before migration 014 first runs against it.
**Files**: `data/migrations/014_electronics_category.sql` (verification target only, no code change in this step)
**Test**: Live `.schema items` output matches the column list used in migration 014's INSERT statement exactly; a timestamped backup file exists before first deploy.
**Depends on**: none
**Parallelizable**: No.

### Step 1a: Rebuild items.category CHECK constraint
**What**: Create the database migration that widens `items.category` CHECK from `('book','clothing')` to `('book','clothing','electronics')` via the create-copy-drop-rename protocol. Use explicit column INSERT list (matching plan.md's order, with tenant_id last), widen the CHECK, and recreate all pre-existing indexes and the `items_category_immutable` trigger.
**Files**: `data/migrations/014_electronics_category.sql`, `lib/db.ts`
**Test**: Run `npm run db:migrate` or verify `PRAGMA user_version` returns 14. Spot-check several rows' full field values before/after (not just COUNT) using `SELECT id, category, status, title FROM items WHERE id IN (...)` to confirm no column scrambling occurred. Verify the immutability trigger: `SELECT sql FROM sqlite_master WHERE name='items_category_immutable'` returns non-null. Verify all expected indexes present via `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'` (should include `idx_items_category`, `idx_items_status`, `idx_items_tenant`, `idx_items_tenant_status`, and new composite tenant-category index). Verify row counts and foreign-key integrity for price_history and item_platforms unchanged (`SELECT COUNT(*) FROM price_history`, `SELECT COUNT(*) FROM item_platforms` before/after match).
**Depends on**: Step 0
**Parallelizable**: No — foundational; all schema-dependent work follows this.
**Rollback note**: Rolling back the migration file does NOT undo an already-applied schema change; recovery requires restoring the Step 0 backup.

### Step 1b: Create electronics_details table and add tenant-matching triggers
**What**: Add the `electronics_details` satellite table with device-specific columns (device_type NOT NULL DEFAULT 'laptop', brand NOT NULL, model NOT NULL, processor, ram_gb, storage_gb, screen_size_in, battery_health_pct, battery_cycle_count, condition NOT NULL), including CHECK constraints on numeric ranges and condition values. Create indexes on tenant_id, brand, and condition. Add `electronics_details_tenant_matches_item` INSERT/UPDATE triggers to enforce multi-tenant isolation.
**Files**: `data/migrations/014_electronics_category.sql`, `lib/db.ts`
**Test**: Run `npm run db:migrate`. Verify `SELECT sql FROM sqlite_master WHERE type='table' AND name='electronics_details';` returns a schema including device_type (DEFAULT 'laptop'), brand, model, battery_health_pct, battery_cycle_count, and a CHECK on condition. Verify all 3 indexes exist. Attempt to INSERT an electronics_details row with tenant_id not matching the parent items row's tenant_id; assert the trigger rejects it. Verify `PRAGMA user_version` returns 14.
**Depends on**: Step 0
**Parallelizable**: Yes — this is additive and independent of the CHECK rebuild's schema verification.

### Step 2: Update lib/constants.ts with electronics vocabulary and platforms
**What**: Add `ELECTRONICS_CONDITIONS` (the 5-label refurbished-laptop grading vocabulary: `['New', 'Excellent', 'Good', 'Fair', 'For Parts']`), extend `CATEGORIES` to include `'electronics'`, add `'electronics'` case to `conditionsForCategory` (exhaustive switch), add `'swappa'` to `SUPPORTED_PLATFORMS`, define `SWAPPA_ACTION_INTERVAL_MS = 10_000`, and add new `platformsForCategory(category)` helper returning the correct platform subset for each category.
**Files**: `lib/constants.ts`
**Test**: `conditionsForCategory('electronics')` returns the 5-element array in order; `platformsForCategory('electronics')` includes `'swappa'` and excludes Etsy/Depop/Vinted; `platformsForCategory('book')` excludes `'swappa'`; `CATEGORIES` includes `'electronics'`; `SUPPORTED_PLATFORMS` includes `'swappa'`. TypeScript compilation succeeds (exhaustive-switch check on both helpers).
**Depends on**: none
**Parallelizable**: Yes — pure TypeScript constants with no runtime/DB dependency.

### Step 3: Update lib/types.ts with ElectronicsDetails interface and extended Item union
**What**: Add `ElectronicsDetails` TypeScript interface mirroring `BookDetails`/`ClothingDetails`'s shape (device_type, brand, model, processor, ram_gb, storage_gb, screen_size_in, battery_health_pct, battery_cycle_count, condition), and extend the `Item` discriminated union with a new arm `(ItemBase & { category: 'electronics'; details: ElectronicsDetails })`.
**Files**: `lib/types.ts`
**Test**: TypeScript compilation succeeds. Code that switches on `item.category` fails compilation if the `'electronics'` case is not handled (exhaustive-switch check). `ElectronicsDetails` interface is properly exported and includes device_type field.
**Depends on**: none
**Parallelizable**: Yes — pure TypeScript types with no runtime dependency.

### Step 4: Update lib/connectors/types.ts with ListingInput widening and UnsupportedCategoryError
**What**: Widen `ListingInput.category` from `'book' | 'clothing'` to `'book' | 'clothing' | 'electronics'`, widen `ListingInput.details` union to include `ElectronicsDetails`, and add a new `UnsupportedCategoryError` exception class exported alongside `ConnectorError`.
**Files**: `lib/connectors/types.ts`
**Test**: TypeScript compilation succeeds. An `UnsupportedCategoryError` can be constructed with `(platform, category)` and has a `message` property. Code expecting `ListingInput` now accepts electronics items.
**Depends on**: Step 3
**Parallelizable**: No — five connector extensions and three connector guards depend on this.

### Step 5: Create lib/electronics.ts with battery/spec validators
**What**: Create a new validators module mirroring `lib/clothing.ts`, exporting `validateBatteryHealthPct`, `validateBatteryCycleCount`, `validateRamGb`, `validateStorageGb`, and `validateScreenSizeIn`. Each validator accepts an absent/undefined value as valid and returns a typed rejection only if a value is present but out of range (battery_health: 0–100 inclusive, cycle_count: ≥0 inclusive, sizes/RAM: >0 exclusive).
**Files**: `lib/electronics.ts`
**Test**: `validateBatteryHealthPct(undefined)` returns success; `validateBatteryHealthPct(50)` succeeds; `validateBatteryHealthPct(101)` or `validateBatteryHealthPct(-1)` returns typed rejection. Same for cycle_count (accepts undefined and ≥0), ram_gb (accepts undefined and >0), etc.
**Depends on**: Step 2
**Parallelizable**: Yes — no file created in this step is referenced by any other unfinished step yet (validators are used in API handlers, which come later).

### Step 6: Update lib/connectors/listingContent.ts to build electronics listing description
**What**: Extend `buildListingDescription` to handle `category: 'electronics'`, building a description branch that includes brand, model, processor, RAM, storage, screen size, battery health, cycle count, and condition—formatted the same way as existing book/clothing branches (`.filter(Boolean).join('\n')`), with null/undefined fields omitted.
**Files**: `lib/connectors/listingContent.ts`
**Test**: Call `buildListingDescription` with a representative electronics `ListingInput` (brand='Apple', model='MacBook Pro', processor='M2', ram_gb=16, etc.); assert the result includes 'Apple', 'M2', and condition label, and omits fields left undefined. Verify branch handles all nullable fields gracefully.
**Depends on**: Step 4
**Parallelizable**: Yes — this helper is called by connectors, but the connectors also have other logic; this can be developed independently as long as it's tested.

### Step 7: Update lib/connectors/mercari.ts to support electronics
**What**: Extend Mercari's category-specific field-mapping code (the `fillCategoryFields` function or equivalent) to handle `category: 'electronics'`, mapping `ElectronicsDetails` fields (specs, condition) into the platform's listing-content constructor the same way `ClothingDetails` are mapped today. Gating, pacing, and suspension logic remain unchanged.
**Files**: `lib/connectors/mercari.ts`
**Test**: Call `createListing` with an electronics `ListingInput`; assert the resulting Mercari listing-content payload includes the mapped electronics fields (brand, specs, condition) and not book/clothing fields. Verify the call runs through the same gating and pacing as before.
**Depends on**: Step 6
**Parallelizable**: Yes — this is one of five independent connector extensions.

### Step 8: Update lib/connectors/poshmark.ts to support electronics
**What**: Extend Poshmark's category-specific field-mapping to accept and map `category: 'electronics'` items, building listing content with electronics-specific fields (brand, model, condition, battery health, processor, RAM, storage, screen size). Gating, pacing, and suspension logic unchanged.
**Files**: `lib/connectors/poshmark.ts`
**Test**: Call `createListing` with an electronics `ListingInput`; assert resulting listing content includes electronics fields and no book/clothing fields. Verify gating/pacing/suspension behavior is unchanged.
**Depends on**: Step 6
**Parallelizable**: Yes — independent of other connector extensions.

### Step 9: Update lib/connectors/amazon.ts to support electronics
**What**: Extend Amazon's SP-API payload builder to accept `category: 'electronics'` and map `ElectronicsDetails` into the item-attributes / listing-description fields of an electronics listing. Gating, pacing, suspension logic unchanged.
**Files**: `lib/connectors/amazon.ts`
**Test**: Call `createListing` with electronics `ListingInput`; assert the SP-API payload includes electronics attributes (brand, processor, RAM, storage, battery health, condition) and not book/clothing attributes. Verify all existing gating/pacing still applies.
**Depends on**: Step 6
**Parallelizable**: Yes — independent of other connector extensions.

### Step 10: Update lib/connectors/ebay.ts to support electronics
**What**: Extend eBay's Trading-API / REST payload builder to accept and map `category: 'electronics'` items, including electronics-specific fields (brand, model, condition, battery health/cycle count, processor, RAM, storage, screen size) into the listing-description or item-specifics section. Gating, pacing, suspension logic unchanged.
**Files**: `lib/connectors/ebay.ts`
**Test**: Call `createListing` with electronics `ListingInput`; assert the eBay payload includes electronics fields and excludes book/clothing fields. Verify gating/pacing/suspension are unchanged.
**Depends on**: Step 6
**Parallelizable**: Yes — independent of other connector extensions.

### Step 11: Update lib/connectors/grailed.ts to support electronics
**What**: Extend Grailed's Playwright-driven form-filling code (the `fillCategoryFields` or equivalent) to accept `category: 'electronics'` and populate electronics-specific fields (brand, model, condition, battery health, processor, RAM, storage, screen size) into the Grailed listing form. Gating, pacing, suspension logic unchanged.
**Files**: `lib/connectors/grailed.ts`
**Test**: Call `createListing` with electronics `ListingInput`; assert the form-fill sequence includes electronics-specific inputs and the resulting listing content includes brand, model, condition, and battery info. Verify all gating/pacing/suspension behavior is preserved.
**Depends on**: Step 6
**Parallelizable**: Yes — independent of other connector extensions.

### Step 12: Add electronics rejection guards to Etsy, Depop, and Vinted connectors
**What**: Add a guard at the top of each connector's `createListing` method: `if (input.category === 'electronics') throw new UnsupportedCategoryError(platform, input.category);` for Etsy, Depop, and Vinted. Each continues to support only book/clothing in this increment.
**Files**: `lib/connectors/etsy.ts`, `lib/connectors/depop.ts`, `lib/connectors/vinted.ts`
**Test**: For each connector (Etsy, Depop, Vinted): call `createListing` with `category: 'electronics'` and assert it throws `UnsupportedCategoryError` with `message` containing both the platform name and 'electronics'. Call with book/clothing categories; assert each proceeds normally (no rejection).
**Depends on**: Step 4
**Parallelizable**: Yes — independent of other connector extensions.

### Step 13a: Create lib/connectors/swappa.ts with createListing method
**What**: Build a new Swappa connector following the browser-automation tier conventions (Playwright-driven, `withSession`/`buildSessionHooks`, in-memory pacing via `enforcePacing`), modeled on `grailed.ts` (similar scale, no durable-ban table, no share-post mechanic). Implement `createListing` with category-rejection-as-first-statement: rejects non-electronics via `UnsupportedCategoryError` before any other logic, then runs Playwright session logic to fill a Swappa listing form with device specs. Include dry-run support and credential scrubbing via the shared `scrub.ts` utility. Call the new `assertCategorySupported()` helper (from Step 2's additions) as part of the rejection logic.
**Files**: `lib/connectors/swappa.ts`
**Test**: Verify TypeScript compilation. Call `createListing` with book/clothing; assert it throws `UnsupportedCategoryError` immediately. Mock `playwrightSession.ts`'s `withSession` at the module level (same technique as `grailed.test.ts`/`poshmark.test.ts`) and assert it's called with the expected session-hooks shape when a valid (non-placeholder) credential is present. Assert `withSession` is NEVER called when `credential_status` is 'placeholder' (dry-run instead, returns success without launching a browser). Verify credential/error messages are scrubbed via spot-checks against the shared `scrub.ts` utility.
**Depends on**: Step 4
**Parallelizable**: No — this is the foundational Swappa platform code.

### Step 13b: Complete lib/connectors/swappa.ts with updateListing, markSold, delist, checkConnectionHealth
**What**: Implement the remaining four Connector methods (`updateListing`, `markSold`, `delist`, `checkConnectionHealth`) in `swappa.ts`, including session-hook wiring for each. Each method follows the same gating/pacing/dry-run pattern as `createListing`.
**Files**: `lib/connectors/swappa.ts`
**Test**: Verify TypeScript compilation. Call each method with electronics item; verify it respects gating (no network call when consent invalid or status not 'active'), respects dry-run behavior (logs intended action without launching browser when credential_status='placeholder'), and returns expected success/error responses. Verify each method correctly routes through the shared session-hooks layer.
**Depends on**: Step 13a
**Parallelizable**: No — depends on Step 13a's foundation.

### Step 14: Register Swappa in pacing, registry, and platform tiers
**What**: Add `'swappa'` to the `PacedPlatform` type and `PACING_WINDOW_MS` record in `pacing.ts` (set to `SWAPPA_ACTION_INTERVAL_MS` from Step 2). Register `swappaConnector` in `lib/connectors/registry.ts` via `swappa: buildConnector('swappa', swappaConnector)` in the `CONNECTORS` object. Add `swappa: 'credential'` entry to `lib/constants/operabilityTiers.ts` so Swappa appears under the "Credential" section in the connection UI.
**Files**: `lib/connectors/pacing.ts`, `lib/connectors/registry.ts`, `lib/constants/operabilityTiers.ts`
**Test**: `getConnector('swappa')` returns a gated `Connector`-shaped object. `PACING_WINDOW_MS['swappa']` equals `SWAPPA_ACTION_INTERVAL_MS`. TypeScript compilation succeeds (registry satisfies type constraint). Platform tier list includes swappa as a credential tier.
**Depends on**: Step 2, Step 13b
**Parallelizable**: No — follows Swappa connector creation.

### Step 15: Update app/api/items/route.ts POST handler to accept electronics
**What**: Extend the `POST /api/items` handler to accept `category: 'electronics'` and route to a new `handleElectronicsCreate` function (mirroring `handleBookCreate`/`handleClothingCreate`). Use an exhaustive switch statement instead of if/return chains. Validate required fields (device_type='laptop', brand, model, condition from `ELECTRONICS_CONDITIONS`) and optional fields (processor, ram_gb, storage_gb, screen_size_in, battery_health_pct, battery_cycle_count) using validators from `lib/electronics.ts`. Insert into both `items` and `electronics_details` tables. Return the full electronics item in the 201 response.
**Files**: `app/api/items/route.ts`
**Test**: POST with `category: 'electronics'`, device_type='laptop', brand='Apple', model='MacBook Pro', condition='Excellent', battery_health_pct=92; assert 201 with the item returned and `details.battery_health_pct === 92`. POST with battery_health_pct=101; assert 422 with validation error. POST with condition='Invalid'; assert 422. Omit optional fields; assert 201 succeeds (both fields nullable). Additionally assert that with the full feature deployed, POSTing `category: 'electronics'` never reaches `handleClothingCreate`'s code path (e.g. via a spy/mock assertion, or by asserting the created row's category is exactly 'electronics', never silently 'clothing') — this guards against the exhaustive-switch restructure regressing back to a silent if/return fallthrough.
**Depends on**: Step 1a, Step 1b, Step 3, Step 5
**Parallelizable**: No — depends on database schema and types.

### Step 16: Update app/api/items/[id]/route.ts GET and PATCH handlers
**What**: Extend the `GET /api/items/[id]` handler to fetch and return `electronics_details` when `category === 'electronics'`. Extend the `PATCH` handler to accept all patchable electronics fields (brand, model, processor, ram_gb, storage_gb, screen_size_in, condition, battery_health_pct, battery_cycle_count) via an exhaustive allowlist (using a switch statement per plan.md) and the existing terminal-status-exclusion pattern. Validate via `ELECTRONICS_FIELD_VALIDATORS` and update the `electronics_details` row.
**Files**: `app/api/items/[id]/route.ts`
**Test**: GET an electronics item; assert response includes `details` shaped like `ElectronicsDetails` with all fields. PATCH with `brand='Dell'`; assert 200 and the field is updated. PATCH with `battery_health_pct=85`; assert 200. PATCH with `processor='Intel i7'`; assert 200. PATCH with status='Sold' and any patchable field; assert 409 (terminal status). PATCH an unknown field; assert 200 (silently ignored, existing behavior).
**Depends on**: Step 1a, Step 1b, Step 3, Step 5
**Parallelizable**: No — depends on database schema and types.

### Step 17: Add server-side platform-category enforcement to PATCH /api/items/[id]
**What**: Extend the PATCH handler's platforms-field validation to check each submitted platform against `PLATFORM_CATEGORY_SUPPORT[item.category]` (the new map from Step 2) and reject with 422 any platform not supported for that item's category. Use the new `assertCategorySupported()` helper to validate.
**Files**: `app/api/items/[id]/route.ts`, `lib/constants.ts`
**Test**: PATCH a book item with `platforms: ['swappa']` and assert 422. PATCH an electronics item with `platforms: ['etsy']` and assert 422. PATCH an electronics item with `platforms: ['swappa']` and assert 200. PATCH a book item with `platforms: ['mercari']` and assert 200.
**Depends on**: Step 2, Step 16
**Parallelizable**: No.

### Step 18: Update lib/dashboard.ts to include electronics in totals and by-category breakdown
**What**: Extend the dashboard query to fetch electronics items and render a third category row (alongside book/clothing). Seed `by_condition` with `ELECTRONICS_CONDITIONS` and run a per-category query on `electronics_details` to count items by condition. The `by_category` query already generalizes via `CATEGORIES.forEach`, so it auto-includes electronics once constants are updated.
**Files**: `lib/dashboard.ts`
**Test**: Create a mix of book (3 rows), clothing (2 rows), and electronics (4 rows). Call `/api/dashboard`; assert `by_category.electronics.count === 4`, `by_category.book.count === 3`, `by_category.clothing.count === 2`. Assert `by_condition` includes electronics rows counted in the appropriate condition categories.
**Depends on**: Step 2, Step 1a, Step 1b
**Parallelizable**: Yes — independent of other API updates.

### Step 19: Update app/api/export/route.ts to include electronics CSV columns
**What**: Add electronics-specific columns to CSV export (`model`, `processor`, `ram_gb`, `storage_gb`, `screen_size_in`, `battery_health_pct`, `battery_cycle_count`), left blank for book/clothing rows. Reuse the existing `brand` and `condition` columns, populating them from `electronics_details` on electronics rows (extending the existing merge logic that already combines `book_details.condition` and `clothing_details.condition` into one CSV `condition` cell). Modify `fetchExportRows` to join `electronics_details` and alias columns appropriately (e.g., `ed.brand AS brand` vs `cd.brand AS brand`).
**Files**: `app/api/export/route.ts`
**Test**: Export a mixed-category inventory (book, clothing, electronics rows); assert each CSV row has blank book/clothing columns on non-matching category rows, and electronics columns are blank on book/clothing rows. Assert `brand` and `condition` cells are populated correctly for electronics rows from `electronics_details`. Explicitly assert an electronics row's brand/condition cells are populated from electronics_details specifically, never from a coincidentally-matching clothing_details row for the same or different item_id (i.e., assert column aliases never cross-contaminate). Round-trip import the same CSV; assert no data loss.
**Depends on**: Step 1a, Step 1b, Step 3
**Parallelizable**: Yes — independent of other export/import work.

### Step 20: Update app/api/import/route.ts to accept electronics CSV import
**What**: Extend CSV import to recognize and parse electronics rows (category='electronics', with model/processor/battery fields). Validate required fields (brand, model, condition) and optional fields using `lib/electronics.ts` validators. Collect per-row errors without aborting the batch (existing behavior for book/clothing). Insert into both `items` and `electronics_details` tables for each valid electronics row.
**Files**: `app/api/import/route.ts`
**Test**: Upload a CSV with electronics, book, and clothing rows mixed. Assert all valid rows are imported. An electronics row with condition='Invalid' produces a per-row error but does not abort the batch. A row with battery_health_pct=101 produces a validation error. All book/clothing rows import unchanged. Round-trip export/import with mixed categories preserves all data and category assignments.
**Depends on**: Step 1a, Step 1b, Step 3, Step 5
**Parallelizable**: Yes — independent of other export/import work.

### Step 21: Create components/AddElectronicsForm.tsx (new form component)
**What**: Create a new form component mirroring `AddClothingForm.tsx`, accepting user input for device_type (fixed to 'laptop'), brand, model, processor, RAM/storage/screen-size specs, battery health, cycle count, and condition. Reuse existing shared components (`AcquisitionFields`, `ConditionSelect` configured for `ELECTRONICS_CONDITIONS`, `SubmitButton`, `SubmitError`, `FieldError`) and the existing `useSubmitItemForm` hook. No new form-plumbing component needed; brand/model are plain text inputs (no seeded-vocabulary combobox, per plan).
**Files**: `components/AddElectronicsForm.tsx`
**Test**: Render the form; assert all required fields (device_type='laptop', brand, model, condition) and optional spec fields are present. Submit valid data; assert the form posts to `/api/items` with `category: 'electronics'` and `device_type: 'laptop'`. Submit with required field missing; assert inline validation error. Submit with invalid battery_health_pct (e.g., 150); assert validation error before API call.
**Depends on**: Step 2, Step 3
**Parallelizable**: Yes — independent of other UI updates.

### Step 22: Update app/inventory/new/page.tsx to add electronics tab
**What**: Add a third tab to the category picker ("Electronics") next to Book and Clothing. When selected, render the new `AddElectronicsForm` component. Existing tab structure and styling are preserved.
**Files**: `app/inventory/new/page.tsx`
**Test**: Navigate to `/inventory/new`; assert three tabs are visible (Book, Clothing, Electronics). Click Electronics tab; assert `AddElectronicsForm` is rendered. Submit a form; assert item is created with `category: 'electronics'`.
**Depends on**: Step 21
**Parallelizable**: No — depends on Step 21's AddElectronicsForm component.

### Step 23: Create components/ElectronicsDetailRows.tsx (detail-page display component)
**What**: Create a new component mirroring `BookDetailRows.tsx` and `ClothingDetailRows.tsx`, rendering electronics-specific fields (device_type, brand, model, processor, RAM/storage/screen-size specs, battery health/cycle count, condition) in a grid/list layout consistent with existing detail-row styling.
**Files**: `components/ElectronicsDetailRows.tsx`
**Test**: Pass an electronics item with full details; assert all fields are rendered. Pass an electronics item with nullable fields omitted; assert those fields are either omitted or shown as "N/A" (consistent with existing component behavior).
**Depends on**: Step 3
**Parallelizable**: Yes — independent of other UI updates.

### Step 24a: Add electronics detail rendering and styling to detail page and card grid
**What**: In `app/inventory/[id]/page.tsx`, extend the detail-rendering switch to show `ElectronicsDetailRows` when `category === 'electronics'`. In `components/ItemCardGrid.tsx`, add `'electronics'` entry to `CATEGORY_STYLES` record (color/styling for electronics cards) and extend the category-emoji ternary (`📖`/`👕`) to include `💻` for electronics. Extend both components' category switches to handle the third category (compile-time exhaustive-switch check ensures this).
**Files**: `app/inventory/[id]/page.tsx`, `components/ItemCardGrid.tsx`
**Test**: Navigate to an electronics item detail page; assert `ElectronicsDetailRows` is rendered. Navigate to inventory list; assert electronics items show the `💻` emoji and appropriate color styling. TypeScript compilation succeeds (exhaustive-switch checks on both category switches).
**Depends on**: Step 23, Step 2
**Parallelizable**: Yes — independent of Step 24b.

### Step 24b: Replace platform-picker free-text input with category-filtered multi-select
**What**: Replace the free-text "Platforms" input field in the detail page's `EditListingForm` with a category-filtered multi-select checkbox/picker populated from `platformsForCategory(item.category)`, so electronics items can only select {mercari, poshmark, amazon, ebay, grailed, swappa} and book/clothing items cannot select swappa. Add to the Test field a spot-check for existing item_platforms rows to identify any non-canonical platform strings that predate this UI change.
**Files**: `app/inventory/[id]/page.tsx`
**Test**: Open the platform-picker field on an electronics item; assert it only offers {mercari, poshmark, amazon, ebay, grailed, swappa}. Open it on a book item; assert swappa is NOT offered. Spot-check existing item_platforms rows in the database for values outside SUPPORTED_PLATFORMS before deploying the picker (log/flag any found rather than silently breaking the picker for that item).
**Depends on**: Step 2, Step 24a
**Parallelizable**: No — depends on rendering from Step 24a and constants from Step 2.

### Step 25: Write electronics connector tests for Mercari, Poshmark, Amazon, eBay, Grailed
**What**: For each of the five extended connectors, add a test case to the existing test file (e.g., `lib/connectors/__tests__/mercari.test.ts`) exercising `createListing` with a representative electronics `ListingInput` (brand='Apple', model='MacBook Pro', condition='Excellent', processor='M2', ram_gb=16, battery_health_pct=92). Assert the resulting listing-content payload includes all mapped electronics fields and excludes book/clothing fields. Verify gating/pacing/suspension behavior is unchanged. (FR18/AC8)
**Files**: `lib/connectors/__tests__/mercari.test.ts`, `lib/connectors/__tests__/poshmark.test.ts`, `lib/connectors/__tests__/amazon.test.ts`, `lib/connectors/__tests__/ebay.test.ts`, `lib/connectors/__tests__/grailed.test.ts`
**Test**: `npm test lib/connectors/__tests__/{mercari,poshmark,amazon,ebay,grailed}.test.ts` passes. Each connector's electronics test asserts the listing content includes expected fields (brand, model, processor, condition, battery info where applicable).
**Depends on**: Step 7, Step 8, Step 9, Step 10, Step 11
**Parallelizable**: Yes — each test file is independent.

### Step 26: Write rejection and comprehensive tests for Etsy, Depop, Vinted, and Swappa
**What**: For Etsy, Depop, Vinted, add a test case verifying that `createListing` with `category: 'electronics'` throws `UnsupportedCategoryError` before any connector logic runs (FR15/AC9). For Swappa, create a comprehensive test file (`lib/connectors/__tests__/swappa.test.ts`) covering: (1) gating (no network call when consent is invalid or status is not 'active'), (2) dry-run behavior (with `credential_status: 'placeholder'`, constructs and logs the intended action without launching a real browser), (3) category rejection (throws `UnsupportedCategoryError` for book/clothing), (4) valid electronics listing (with a mocked/dry-run session, verifies the expected Playwright call sequence or logged intent), and (5) credential scrubbing (assert no credential value appears in any thrown error, log line, or recordSuspensionSignal reason string produced by the Swappa connector, mirroring the existing scrub.ts test suite's assertions). Ensure `npm test` never launches a real Playwright browser for Swappa, regardless of local credential state (FR25/AC13).
**Files**: `lib/connectors/__tests__/etsy.test.ts`, `lib/connectors/__tests__/depop.test.ts`, `lib/connectors/__tests__/vinted.test.ts`, `lib/connectors/__tests__/swappa.test.ts`
**Test**: `npm test` runs to completion. `etsy.test.ts`, `depop.test.ts`, `vinted.test.ts` each include an electronics-rejection assertion. `swappa.test.ts` includes five test suites: gating (verifies no network calls when invalid), dry-run (verifies log output, no browser launch), category rejection, valid electronics scenario (no real browser launched), and credential scrubbing (assert no credential values leak into errors/logs). All assertions pass; no real browser is launched by `npm test`.
**Depends on**: Step 12, Step 13a, Step 13b, Step 14
**Parallelizable**: Yes — each test file is independent.

## Rollback plan

**Step 0 (database backup)**: Ensures a restore point exists before any schema changes.

**Steps 1a–1b (migration and schema)**: Reverse via `git checkout` on the migration file. **Important**: Rolling back the migration file does NOT undo an already-applied schema change (the CHECK is widened only in the live database); recovery requires restoring `data/inventory.db` from the Step 0 backup. `PRAGMA user_version` will revert to 13 only if the backup is restored or a further rollback migration is run.

**Steps 2–6 (types, validators, listing content, constants)**: Reverse via `git checkout`. No data loss; types, validators, and constants are compile-time-only (except constants used by Steps 14+ at runtime).

**Steps 7–12 (connector implementations and guards)**: Reverse via `git checkout` for each file. Connectors default to error/no-op if category-routing is reverted; existing book/clothing logic is unchanged.

**Steps 13a–14 (Swappa connector and registration)**: Reverse via `git checkout`. `getConnector('swappa')` will return undefined or throw if the file and registry entry are removed.

**Steps 15–20 (API layer and export/import)**: Reverse via `git checkout`. If schema is still at version 14 but API code is rolled back, POST requests with `category: 'electronics'` will fail validation or be rejected. Existing book/clothing APIs are unaffected.

**Steps 21–24b (UI components and forms)**: Reverse via `git checkout`. The category picker tab and item-detail rendering will revert to the previous state. No data loss.

**Steps 25–26 (tests)**: Reverse via `git checkout` on test files. Tests simply won't run; no data loss or runtime impact.

**All-at-once rollback**: Revert all changes via `git reset --hard HEAD~N` (replace N with the number of commits). The `items.category` CHECK is widened only in the live database (Step 1a); reverting the migration file doesn't undo the database change. To fully roll back, restore `data/inventory.db` from the Step 0 backup taken before Step 1a, then `git reset`.

If rolling back after electronics items have been created:
- Electronics rows in `items` (and `electronics_details`) remain but cannot be created/updated via the reverted API/UI.
- The `items.category` CHECK remains widened (migration 14 persists in `PRAGMA user_version`); the codebase must either stay at version 14 or run a further migration to narrow the CHECK again (a destructive rebuild, requiring the same `multi-category-inventory` reverse-migration protocol).
- Recommended approach: keep the feature deployed; rolling back partially is not safe for a multi-tenant schema change.

