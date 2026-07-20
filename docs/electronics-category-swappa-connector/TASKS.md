# Tasks: Electronics Category + Swappa Connector

Generated from: docs/electronics-category-swappa-connector/ on 2026-07-19

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 0: Verify live schema and back up database
**Status**: [x] done
**Files**: data/migrations/014_electronics_category.sql (verification target only)
**Test**: Live `.schema items` output matches migration 014's assumed column list; a timestamped backup exists before first deploy.
**Depends on**: none
**Parallelizable**: No
**Notes**: Confirmed live schema matches assumed order exactly (tenant_id physically last). Backup created: inventory.db.bak-20260719221217.

### Task 1a: Rebuild items.category CHECK constraint
**Status**: [x] done
**Files**: data/migrations/014_electronics_category.sql, lib/db.ts
**Test**: PRAGMA user_version=14; spot-check row data pre/post; trigger + all indexes present; price_history/item_platforms row counts unchanged.
**Depends on**: Task 0
**Parallelizable**: No
**Notes**: Initial version failed against real better-sqlite3 runtime on `ALTER TABLE items_v2 RENAME TO items` (other satellite tables' triggers referencing `items` tripped non-legacy rename's schema-wide validation). Fixed with `PRAGMA legacy_alter_table = ON/OFF` bracketing the RENAME statement; re-verified end-to-end against the real engine (migrations 001-014 applied fresh, user_version=14, no error).

### Task 1b: Create electronics_details table and triggers
**Status**: [x] done
**Files**: data/migrations/014_electronics_category.sql, lib/db.ts
**Test**: electronics_details schema correct; tenant + category matching triggers reject mismatches; PRAGMA user_version=14.
**Depends on**: Task 1a
**Parallelizable**: No
**Notes**: Content verified correct in isolation before Task 1a's blocker was found/fixed.

### Task 2: Update lib/constants.ts
**Status**: [x] done
**Files**: lib/constants.ts
**Test**: conditionsForCategory/platformsForCategory correct; CATEGORIES/SUPPORTED_PLATFORMS widened; PLATFORM_CATEGORY_SUPPORT + assertCategorySupported + LAPTOP_BRANDS present; compiles.
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 3: Update lib/types.ts
**Status**: [x] done
**Files**: lib/types.ts
**Test**: ElectronicsDetails interface added; Item union widened; exhaustive-switch compile check works.
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 4: Update lib/connectors/types.ts
**Status**: [x] done
**Files**: lib/connectors/types.ts
**Test**: ListingInput widened; UnsupportedCategoryError added; compiles.
**Depends on**: Task 3
**Parallelizable**: No
**Notes**:

### Task 5: Create lib/electronics.ts validators
**Status**: [x] done
**Files**: lib/electronics.ts
**Test**: validateBatteryHealthPct/validateBatteryCycleCount/validateRamGb/validateStorageGb/validateScreenSizeIn — nullable-accepting, range-rejecting.
**Depends on**: Task 2
**Parallelizable**: Yes
**Notes**:

### Task 6: Update lib/connectors/listingContent.ts
**Status**: [x] done
**Files**: lib/connectors/listingContent.ts
**Test**: buildListingDescription electronics branch; restructured to exhaustive switch.
**Depends on**: Task 4
**Parallelizable**: Yes
**Notes**:

### Task 7: Update lib/connectors/mercari.ts
**Status**: [x] done
**Files**: lib/connectors/mercari.ts
**Test**: createListing accepts electronics, maps fields, calls assertCategorySupported first.
**Depends on**: Task 6
**Parallelizable**: Yes
**Notes**:

### Task 8: Update lib/connectors/poshmark.ts
**Status**: [x] done
**Files**: lib/connectors/poshmark.ts
**Test**: same shape as Task 7.
**Depends on**: Task 6
**Parallelizable**: Yes
**Notes**:

### Task 9: Update lib/connectors/amazon.ts
**Status**: [x] done
**Files**: lib/connectors/amazon.ts
**Test**: same shape as Task 7.
**Depends on**: Task 6
**Parallelizable**: Yes
**Notes**:

### Task 10: Update lib/connectors/ebay.ts
**Status**: [x] done
**Files**: lib/connectors/ebay.ts
**Test**: same shape as Task 7.
**Depends on**: Task 6
**Parallelizable**: Yes
**Notes**:

### Task 11: Update lib/connectors/grailed.ts
**Status**: [x] done
**Files**: lib/connectors/grailed.ts
**Test**: same shape as Task 7.
**Depends on**: Task 6
**Parallelizable**: Yes
**Notes**:

### Task 12: Add rejection guards to Etsy, Depop, Vinted
**Status**: [x] done
**Files**: lib/connectors/etsy.ts, lib/connectors/depop.ts, lib/connectors/vinted.ts
**Test**: each throws UnsupportedCategoryError via assertCategorySupported for electronics; book/clothing unaffected.
**Depends on**: Task 4
**Parallelizable**: Yes
**Notes**:

### Task 13a: Create lib/connectors/swappa.ts createListing
**Status**: [x] done
**Files**: lib/connectors/swappa.ts
**Test**: rejects book/clothing; dry-run when placeholder credential; withSession mocked correctly.
**Depends on**: Task 4
**Parallelizable**: No
**Notes**:

### Task 13b: Complete swappa.ts remaining methods
**Status**: [x] done
**Files**: lib/connectors/swappa.ts
**Test**: updateListing/markSold/delist/checkConnectionHealth follow gating/pacing/dry-run pattern.
**Depends on**: Task 13a
**Parallelizable**: No
**Notes**:

### Task 14: Register Swappa in pacing/registry/operabilityTiers
**Status**: [x] done
**Files**: lib/connectors/pacing.ts, lib/connectors/registry.ts, lib/constants/operabilityTiers.ts, lib/constants/platformTiers.ts, lib/constants/credentialFieldSpecs.ts, lib/constants/riskCopy.ts
**Test**: getConnector('swappa') works; PACING_WINDOW_MS['swappa'] set; both tier maps compile.
**Depends on**: Task 2, Task 13b
**Parallelizable**: No
**Notes**: Also needed credentialFieldSpecs.ts + riskCopy.ts entries (found via `tsc --noEmit | grep swappa`). All swappa-related compile errors resolved.

### Task 15: Update app/api/items/route.ts POST handler
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: exhaustive switch; electronics creates correctly; never falls through to handleClothingCreate.
**Depends on**: Task 1a, Task 1b, Task 3, Task 5
**Parallelizable**: No
**Notes**:

### Task 16: Update app/api/items/[id]/route.ts GET and PATCH
**Status**: [x] done
**Files**: app/api/items/[id]/route.ts
**Test**: GET returns electronics_details; PATCH allows all electronics_details fields; exhaustive switch.
**Depends on**: Task 1a, Task 1b, Task 3, Task 5
**Parallelizable**: No
**Notes**:

### Task 17: Add server-side platform-category enforcement to PATCH
**Status**: [x] done
**Files**: app/api/items/[id]/route.ts, lib/constants.ts
**Test**: PATCH book with platforms:['swappa'] -> 422; PATCH electronics with platforms:['etsy'] -> 422; PATCH electronics with platforms:['swappa'] -> 200.
**Depends on**: Task 2, Task 16 (same file as Task 16 — sequential)
**Parallelizable**: No
**Notes**:

### Task 18: Update lib/dashboard.ts
**Status**: [x] done
**Files**: lib/dashboard.ts
**Test**: by_category.electronics.count correct; by_condition includes electronics conditions.
**Depends on**: Task 2, Task 1a, Task 1b
**Parallelizable**: Yes
**Notes**: Agent caught and fixed its own bug: condition labels collide across categories ('Good'/'Fair' appear in multiple vocabularies) — switched merge assignment from `=` to `+=` to avoid clobbering counts.

### Task 19: Update app/api/export/route.ts
**Status**: [x] done
**Files**: app/api/export/route.ts
**Test**: electronics CSV columns present, blank on other categories; no cross-category column leak.
**Depends on**: Task 1a, Task 1b, Task 3
**Parallelizable**: Yes
**Notes**:

### Task 20: Update app/api/import/route.ts
**Status**: [x] done
**Files**: app/api/import/route.ts
**Test**: electronics CSV rows import correctly; per-row errors don't abort batch.
**Depends on**: Task 1a, Task 1b, Task 3, Task 5
**Parallelizable**: Yes
**Notes**:

### Task 21: Create components/AddElectronicsForm.tsx
**Status**: [x] done
**Files**: components/AddElectronicsForm.tsx
**Test**: all fields present incl. LAPTOP_BRANDS select; submits category:'electronics'; validation errors shown.
**Depends on**: Task 2, Task 3
**Parallelizable**: Yes
**Notes**:

### Task 22: Update app/inventory/new/page.tsx
**Status**: [x] done
**Files**: app/inventory/new/page.tsx
**Test**: third "Electronics" tab renders AddElectronicsForm.
**Depends on**: Task 21
**Parallelizable**: No
**Notes**:

### Task 23: Create components/ElectronicsDetailRows.tsx
**Status**: [x] done (merged into Task 24a — see note)
**Files**: components/ElectronicsDetailRows.tsx
**Test**: renders all fields; nullable fields shown as N/A.
**Depends on**: Task 3
**Parallelizable**: Yes
**Notes**: Course correction: plan.md assumed BookDetailRows/ClothingDetailRows are separate component files, but direct code inspection shows they are actually LOCAL functions defined inline at the bottom of app/inventory/[id]/page.tsx, not separate files. ElectronicsDetailRows added as a third inline local function in page.tsx as part of Task 24a instead. Stub file removed.

### Task 24a: Add electronics rendering to detail page and card grid
**Status**: [x] done
**Files**: app/inventory/[id]/page.tsx, components/ItemCardGrid.tsx
**Test**: ElectronicsDetailRows rendered; emoji/color styling added; exhaustive switch compiles.
**Depends on**: Task 23, Task 2
**Parallelizable**: Yes
**Notes**:

### Task 24b: Replace platform-picker with category-filtered multi-select
**Status**: [x] done
**Files**: app/inventory/[id]/page.tsx
**Test**: electronics picker offers exactly 6 platforms incl swappa; book/clothing never offers swappa; existing data spot-checked.
**Depends on**: Task 2, Task 24a (same file — sequential)
**Parallelizable**: No
**Notes**:

### Task 25: Write electronics connector tests (Mercari/Poshmark/Amazon/eBay/Grailed)
**Status**: [x] done
**Files**: lib/connectors/__tests__/mercari.test.ts, lib/connectors/__tests__/poshmark.test.ts, lib/connectors/__tests__/amazon.test.ts, lib/connectors/__tests__/ebay.test.ts, lib/connectors/__tests__/grailed.test.ts
**Test**: npm test passes for all five, asserting electronics field mapping.
**Depends on**: Task 7, Task 8, Task 9, Task 10, Task 11
**Parallelizable**: Yes
**Notes**:

### Task 26: Write rejection + Swappa tests
**Status**: [x] done
**Files**: lib/connectors/__tests__/etsy.test.ts, lib/connectors/__tests__/depop.test.ts, lib/connectors/__tests__/vinted.test.ts, lib/connectors/__tests__/swappa.test.ts
**Test**: rejection tests for etsy/depop/vinted; swappa.test.ts covers gating/dry-run/rejection/valid-listing/scrubbing; no real browser launched.
**Depends on**: Task 12, Task 13a, Task 13b, Task 14
**Parallelizable**: Yes
**Notes**:

## Blocked / open
(none currently — all completed tasks unblocked; Task 1a's transient migration blocker was found and fixed within the same run)
