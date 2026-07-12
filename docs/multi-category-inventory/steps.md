# Steps: Multi-Category Inventory (Clothing)

## Prerequisites

1. **Backup requirement**: Before executing any step that touches the live database (`data/inventory.db`), the owner must create a manual backup via `cp data/inventory.db data/inventory.db.pre-multi-category-backup` or use the `lib/backup.ts` snapshot mechanism. This backup is a non-negotiable change-control gate (per resale-inventory-change-control §(g)) — no session applies the migration autonomously.
2. **Existing book-inventory schema**: The app currently has a single `books` table, `book_platforms` table, and `price_history` table. All existing tests pass against this schema before starting.
3. **No external dependencies to add**: The feature uses only Node.js built-in `fs`, `path`, and Next.js built-in `formData()` parsing; no new npm packages required.

## Implementation steps

### Step 1a: Create the multi-category migration file (DDL only)
**What**: Write the first part of `data/migrations/003_multi_category.sql` with only the DDL: CREATE TABLE items/book_details/clothing_details/item_photos/item_platforms with all indexes and the category-immutability trigger (enforced at API layer as a reminder).
**Files**: `data/migrations/003_multi_category.sql`
**Test**: 
- Run `sqlite3 test-copy.db < data/migrations/003_multi_category.sql` (partial, DDL-only portion) against a test database copy.
- Verify the schema: `sqlite3 test-copy.db ".schema items"` shows the items table with category CHECK; `".schema book_details"` shows book_details with the unchanged 5-value condition enum; `".schema clothing_details"` shows clothing_details with the 5-value clothing condition enum.
- Attempt inserting a clothing-vocabulary condition value (e.g. "EUC") into `book_details` and a book-vocabulary value (e.g. "Very Good") into `clothing_details`; confirm the CHECK constraint itself rejects both (proves DB-level enforcement, not just app-layer validation).
**Depends on**: none
**Parallelizable**: No — all subsequent steps depend on this schema definition existing.

### Step 1b: Create the multi-category migration file (data-copy portion)
**What**: Write the second part of `data/migrations/003_multi_category.sql` with data-copy INSERT statements (books→items+book_details, book_platforms→item_platforms, price_history RENAME COLUMN via `ALTER TABLE ... RENAME COLUMN`) and archived-table renames (`books`→`books_archived`, `book_platforms`→`book_platforms_archived`). The archived tables are NOT dropped in this migration — the actual DROP is deferred to a future migration 004, written only once the new schema has run stable in production for at least one release cycle (per plan.md's rollback strategy). The complete migration file combines 1a + 1b into a single transaction.
**Files**: `data/migrations/003_multi_category.sql`
**Test**: 
- Run the complete migration against a test database copy (combining DDL + data copy).
- Verify data integrity: `SELECT COUNT(*) FROM items WHERE category='book'` equals the pre-migration book count.
- Spot-check a Sold book example: run a SELECT comparing specific fields (id, title, author, condition, status, sale_price, sale_date) before and after migration; confirm all values match exactly (field-level, not just row count).
- Verify `SELECT COUNT(*) FROM price_history` matches the old count and `item_id` values are correctly mapped.
- Verify `SELECT COUNT(*) FROM item_platforms` matches the old `book_platforms` count.
**Depends on**: none (Step 1a is the same file, so this step is executed together, but logical dependency is after 1a's schema is in place)
**Parallelizable**: No — migration must sequence strictly.

### Step 1c: Create data/photos/ directory and .gitkeep
**What**: Create `data/photos/` as a subdirectory in the repo with a `.gitkeep` file to track it. Verify `.gitignore` does not exclude the directory itself (only its contents should eventually be ignored). Mirror the pattern used for `data/backups/`.
**Files**: `data/photos/` (create), `.gitkeep`, `.gitignore` (verify)
**Test**: 
- `ls -la data/photos/` should succeed and show `.gitkeep`.
- Grep `.gitignore` for `photos` → no wildcard pattern excludes the directory itself (e.g., no `data/**/photos` pattern). The directory must persist in the repository, but contents (images) will eventually be ignored once uploads start.
- Verify directory structure: `find data/photos -type f` should show only `.gitkeep`, nothing else yet.
**Depends on**: none
**Parallelizable**: Yes.

### Step 2: Extend lib/db.ts versioned migration runner with version-gating fix
**What**: Add a new entry to the `VERSIONED_MIGRATIONS` array in `lib/db.ts` with `{ version: 3, file: '003_multi_category.sql' }`. **CRITICAL FIX:** Gate `001_init.sql`'s execution behind the same version-check mechanism as the numbered migrations (treat baseline as implicit version 1), so it does NOT run unconditionally on every boot. This prevents the old `books`/`book_platforms` tables from being resurrected after the migration renames/drops them.
**Files**: `lib/db.ts`
**Test**: 
- Inspect `lib/db.ts` for the version-gating fix: `001_init.sql` must be guarded by a `schemaVersion < 1` or equivalent check, not executed unconditionally.
- Boot the app TWICE against the same test DB (using `npm run dev` both times) and confirm:
  - First boot: migration runs, final schema shows `items`, `book_details`, etc. (NOT `books` or old `book_platforms`).
  - Second boot: no resurrection of old tables; `sqlite3 test.db ".tables"` still shows only the new schema.
  - `PRAGMA user_version` is 3 after the first boot, still 3 after the second (no second re-migration attempted).
- This is the critical regression test for the bug fix.
**Depends on**: Step 1a (schema definition must exist), Step 1b (migration file complete)
**Parallelizable**: No — migrations must sequence strictly.

### Step 3: Add category and condition constants to lib/constants.ts
**What**: Define `BOOK_CONDITIONS`, `CLOTHING_CONDITIONS`, `CATEGORIES`, and a `conditionsForCategory(category)` helper function so condition validation is centralized and consistent across all routes.
**Files**: `lib/constants.ts`
**Test**: 
- Import `conditionsForCategory` in a Node REPL or test snippet and verify: `conditionsForCategory('book')` returns the 5 book conditions; `conditionsForCategory('clothing')` returns the 5 clothing conditions; `conditionsForCategory('invalid')` throws or returns null predictably.
- Grep the codebase to confirm no other code defines VALID_CONDITIONS or CLOTHING_CONDITIONS already (should be absent).
**Depends on**: none
**Parallelizable**: Yes — no other file depends on this yet; it's only used by routes built in later steps.

### Step 4: Create lib/clothing.ts validation helpers
**What**: Write `lib/clothing.ts` with validation functions `validateWeightOz(value)` (rejects negative or non-integer), and `clothingMeasurementFields` constant listing allowed numeric fields (pit_to_pit_in, length_in, etc.), mirroring the pattern of `lib/isbn.ts` for books.
**Files**: `lib/clothing.ts`
**Test**: 
- Test `validateWeightOz(42)` returns true; `validateWeightOz(-1)` and `validateWeightOz("abc")` return false or throw a validation error.
- Write a unit test file `lib/__tests__/clothing.test.ts` (can be a placeholder for now) that documents the expected validation behavior.
**Depends on**: none
**Parallelizable**: Yes.

### Step 5: Create/extend lib/types.ts with shared TS types
**What**: Add TypeScript type definitions for `Item`, `BookDetails`, `ClothingDetails`, `Photo`, `ItemPlatform` if `lib/types.ts` is still a stub; populate it once to support type-safe API contracts across all routes.
**Files**: `lib/types.ts`
**Test**: 
- Compile the TypeScript: `npx tsc --noEmit` should pass with no errors.
- Inspect that `Item` is exported and has a `category` field that is the union type `'book' | 'clothing'`.
**Depends on**: Step 3 (constants must be available for type definitions that reference condition vocabularies)
**Parallelizable**: Yes — types don't block route implementation.

### Step 6: Write POST /api/items route (create item, category-discriminated)
**What**: Create `app/api/items/route.ts` replacing `app/api/books/route.ts`, with POST handling category-discriminated required-field validation and satellite-table routing (book fields → book_details, clothing fields → clothing_details). Validate condition against the category's vocabulary using the helper from step 3.
**Files**: `app/api/items/route.ts`
**Test**: 
- POST a book item: `{ category: "book", title: "...", author: "...", condition: "Good", acquisition_cost: 1500, acquisition_date: "2024-01-15" }` → 201 response with id, category='book', and a book_details object.
- POST a clothing item: `{ category: "clothing", title: "...", brand: "...", size_label: "M", condition: "EUC", acquisition_cost: 2500, acquisition_date: "2024-01-15" }` → 201 with category='clothing' and a clothing_details object.
- POST a book item with a clothing condition (e.g., "EUC") → 422 validation error.
- POST a clothing item missing required field `size_label` → 422 validation error.
- Confirm `size_label` round-trips exactly as entered (whitespace-trimmed only, no case changes or normalization) — verifies FR9.
**Depends on**: Step 2 (DB schema ready), Step 3 (constants), Step 4 (clothing validation), Step 5 (types)
**Parallelizable**: No — GET /api/items (Step 7) shares the same file.

### Step 7: Write GET /api/items route (search, category filter)
**What**: Extend `app/api/items/route.ts` with GET handling; add `category` and `condition` query parameters, validate condition against the selected category's vocabulary, return items with the correct satellite-table fields joined as `details` per the Item type.
**Files**: `app/api/items/route.ts` (extend Step 6)
**Test**: 
- GET `/api/items?category=book&condition=Good` → returns only book items with condition "Good"; no clothing items appear.
- GET `/api/items?category=clothing&condition=EUC` → returns only clothing items with condition "EUC"; no book items appear.
- GET `/api/items?category=clothing&condition=Good` (a book-only condition) → 422 validation error or empty result (implementation choice; should be 422 per spec).
- GET `/api/items?q=title-substring` → returns items of both categories matching the substring.
**Depends on**: Step 6
**Parallelizable**: No — both POST and GET are in the same file.

### Step 8: Write GET /api/items/[id] route and basic PATCH /api/items/[id] route
**What**: Create `app/api/items/[id]/route.ts` replacing `app/api/books/[id]/route.ts`. GET joins the correct satellite table by category, returns item + details + platforms + price_history + photos (empty array for books, populated for clothing). PATCH updates category-appropriate detail fields (e.g., `condition` for either category, but validated against the category's vocabulary), rejects `category` field in request, and enforces Sold-item lock.
**Files**: `app/api/items/[id]/route.ts`
**Test**: 
- GET a book item → returns object with details.isbn, details.author, details.publisher, details.condition (from book vocabulary), and photos=[].
- GET a clothing item → returns object with details.brand, details.size_label, details.condition (from clothing vocabulary), and photos=[].
- PATCH a book item's condition to "Very Good" → succeeds.
- PATCH a book item's condition to "EUC" (clothing-only) → 422 validation error, condition unchanged.
- PATCH a clothing item with new weight_oz=-5 → 422 validation error.
- PATCH an item's `category` field → 422 error (immutable) or silently ignored (per implementation discipline).
- GET a Sold item, then PATCH any field → 409 error (Sold items are locked).
- Confirm `size_label` round-trips exactly as entered (whitespace-trimmed only, no case changes or normalization) — verifies FR9.
**Depends on**: Step 2 (schema), Step 3 (constants), Step 4 (clothing validation), Step 5 (types)
**Parallelizable**: Yes — independent from routes in steps 7, 9, etc., as long as the schema is ready.

### Step 9: Write POST /api/items/[id]/status route (status transitions)
**What**: Create `app/api/items/[id]/status/route.ts` replacing `app/api/books/[id]/status/route.ts`. Unchanged logic: call `lib/transitions.ts` with the item's current status and requested status (category-blind), enforce the same transition rules for both book and clothing items, set sale_price/sale_date/sale_platform on transition to Sold.
**Files**: `app/api/items/[id]/status/route.ts`
**Test**: 
- Transition a clothing item Unlisted → Listed (with listing_price set) → succeeds.
- Attempt to transition a clothing item Listed → Unlisted → 422 (invalid transition per lib/transitions.ts, same as book).
- Transition a clothing item through the full sequence to Sold, verify sale_price/sale_date/sale_platform are set and immutable.
- Re-run the existing book transition test cases (not just new clothing cases) to confirm no regression in book behavior.
**Depends on**: Step 2, Step 8
**Parallelizable**: Yes.

### Step 10: Write POST /api/items/[id]/photos route and PATCH for reorder
**What**: Create `app/api/items/[id]/photos/route.ts` with POST handling multipart upload. Reject with 422 if item.category != 'clothing'. Write each file to `data/photos/<item_id>/` with a unique filename, insert one `item_photos` row per file with sort_order matching upload order, return full sorted photo array. PATCH reorders photos by receiving a full array of ids and updating sort_order in-place.
**Files**: `app/api/items/[id]/photos/route.ts`
**Test**: 
- Upload 2 JPEG files for a clothing item → POST 201 with photos array containing 2 entries, sort_order=[1,2]; files exist at `data/photos/<item_id>/<filename>`.
- Attempt to upload to a book item → 422 "Photos are not supported for category 'book'."
- Reorder the 2 photos to [2,1] via PATCH → sort_order is swapped in DB, GET /api/items/[id] returns photos in the new order.
- Verify file paths and DB rows are in sync; no orphaned files or missing rows.
- Confirm file-type rejection (non-image upload → 422), path-traversal rejection (crafted filename/item_id → rejected, no write outside data/photos/), and photo-scoping (DELETE/PATCH on a photo id that belongs to a different item → 404).
**Depends on**: Step 2 (schema with item_photos), Step 8 (to retrieve item and check category)
**Parallelizable**: Yes — independent from other photo routes.
**Rollback note**: Dev/test-created files under `data/photos/` are NOT removed by `git checkout`; a dev/test `data/photos/` directory should be manually cleared (`rm -rf data/photos/*` excluding `.gitkeep`) if reverting during development.

### Step 11: Write DELETE /api/items/[id]/photos/[photoId] route
**What**: Create `app/api/items/[id]/photos/[photoId]/route.ts` with DELETE handling. Remove the file from `data/photos/<item_id>/`, delete the row from `item_photos`, compact remaining `sort_order` values (renumber 1,2,3,... after a gap), return the updated photo array.
**Files**: `app/api/items/[id]/photos/[photoId]/route.ts`
**Test**: 
- Given 3 photos with sort_order=[1,2,3], DELETE the second one → remaining photos have sort_order=[1,2] (compacted), file is gone from disk.
- Attempt to DELETE a non-existent photo → 404.
- Attempt to DELETE a photo that belongs to a different item → 404 (not found).
**Depends on**: Step 10
**Parallelizable**: Yes.

### Step 12: Write GET /api/items/[id]/photos/[photoId] route (serve photo bytes)
**What**: Create `app/api/items/[id]/photos/[photoId]/route.ts` with GET handling to serve photo file bytes. Validate that the photo belongs to the specified item (IDOR protection), read the file from `data/photos/<item_id>/<photoId>`, return with appropriate Content-Type header (image/jpeg, image/png, etc.) and caching headers.
**Files**: `app/api/items/[id]/photos/[photoId]/route.ts` (GET method; DELETE already in Step 11)
**Test**: 
- GET a photo for a clothing item → 200 with correct Content-Type and image bytes.
- Attempt to GET a photo with item_id and photo_id mismatch (IDOR) → 404 (not found for this item).
- Attempt to GET a non-existent photo → 404.
**Depends on**: Step 2 (schema), Step 10 (POST must exist first so photos are created)
**Parallelizable**: Yes.

### Step 13: Update GET /api/dashboard route with per-category breakdown
**What**: Extend `app/api/dashboard/route.ts` to add a `by_category` object with book and clothing counts and acquisition costs, alongside the existing combined totals.
**Files**: `app/api/dashboard/route.ts`
**Test**: 
- Create 2 book items (acquisition_cost = 1000 each) and 1 clothing item (acquisition_cost = 2500).
- GET /api/dashboard → assert `by_category.book.count` = 2, `by_category.book.acquisition_cost` = 2000, `by_category.clothing.count` = 1, `by_category.clothing.acquisition_cost` = 2500.
- Assert `held_count` = 3 and `held_acquisition_cost` = 4500 (sum of both categories).
**Depends on**: Step 2 (schema with category column), Step 3 (constants for category-scoped aggregation)
**Parallelizable**: Yes.

### Step 14: Update GET /api/export route (CSV export with category and mixed columns)
**What**: Extend `app/api/export/route.ts` to include a `category` column, all book-specific columns (isbn, author, publisher) and clothing-specific columns (brand, size_label, color, material, gender_department, weight_oz, measurements), and leave non-matching columns blank per row. Rename any `book_platforms` reference to `item_platforms`.
**Files**: `app/api/export/route.ts`
**Test**: 
- Export a database with 1 book and 1 clothing item.
- Verify CSV header includes: id, category, title, isbn, author, publisher, brand, size_label, color, material, gender_department, weight_oz, ..., condition, acquisition_cost_usd, ..., created_at, updated_at.
- Book row: category='book', isbn and author populated, brand/size_label/color/material/... blank.
- Clothing row: category='clothing', brand/size_label populated, isbn/author/publisher blank.
**Depends on**: Step 2 (item_platforms exists), Step 3 (constants)
**Parallelizable**: Yes.

### Step 15: Update POST /api/import route (CSV import with mixed categories)
**What**: Extend `app/api/import/route.ts` to parse the `category` column, apply category-appropriate required-field validation (book rows: title, author, condition, acquisition_cost_usd, acquisition_date; clothing rows: title, brand, size_label, condition, acquisition_cost_usd, acquisition_date), route each valid row to the correct satellite-table insert, and report per-row errors without aborting the batch.
**Files**: `app/api/import/route.ts`
**Test**: 
- Import a CSV with 1 valid book row, 1 valid clothing row, 1 invalid book row (missing author) → response shows imported=2, errors=[{ row: N, fields: ['author'], message: '...' }].
- Verify both valid rows committed to the DB with correct category and satellite-table data.
- Import a CSV with a clothing row missing size_label → per-row error, other rows still commit.
**Depends on**: Step 2 (schema), Step 3 (constants for required-field validation per category), Step 4 (clothing validation helpers)
**Parallelizable**: Yes.

### Step 16a: Create /inventory list and search page
**What**: Create `app/inventory/page.tsx` (replaces app/books/page.tsx), `app/inventory/layout.tsx`, and rename/extend components: `BookTable.tsx` → `ItemTable.tsx` (add category column) and `BookSearch.tsx` → `ItemSearch.tsx` (add category filter, condition filter bound to selected category).
**Files**: `app/inventory/page.tsx`, `app/inventory/layout.tsx`, `components/ItemTable.tsx`, `components/ItemSearch.tsx`
**Test**: 
- Start the app and navigate to `/inventory` → inventory list renders with category column; no book-specific detail columns on clothing rows.
- Confirm the condition dropdown in search/filter only shows conditions valid for the currently-selected category (book conditions when category=book, clothing conditions when category=clothing).
**Depends on**: Steps 6-7 (API routes must be functional)
**Parallelizable**: No — this is the base UI page; others depend on it.

### Step 16b: Create /inventory add-item flow
**What**: Create `app/inventory/new/page.tsx` (with category picker → AddBookForm or AddClothingForm), and create `components/AddClothingForm.tsx`. Rename/reuse existing `AddBookForm`.
**Files**: `app/inventory/new/page.tsx`, `components/AddClothingForm.tsx`, (existing `components/AddBookForm.tsx`)
**Test**: 
- Click `/inventory/new` → category picker appears at top; selecting "book" shows ISBN lookup, selecting "clothing" hides ISBN lookup and shows brand/size_label/color/material fields.
- Add a book item → navigates back to inventory list with new item visible.
- Add a clothing item → navigates to detail page with photo upload UI (from step 16c).
**Depends on**: Step 16a (inventory page must exist), Step 6 (POST /api/items route)
**Parallelizable**: Yes — can be built in parallel with 16c/16d once 16a and routes exist.

### Step 16c: Create /inventory item detail page and photo UI
**What**: Create `app/inventory/[id]/page.tsx` (item detail with category-conditional photo gallery and measurements) and `components/PhotoUpload.tsx` (multi-file upload, drag-to-reorder, delete UI). Render category-specific detail block; photo gallery + reorder/delete UI only when category = clothing.
**Files**: `app/inventory/[id]/page.tsx`, `components/PhotoUpload.tsx`
**Test**: 
- Navigate to a clothing item detail page → photo upload UI appears with drag-to-reorder and delete buttons.
- Upload 3 photos → all appear in the gallery.
- Reorder photos in the gallery → new order persists on reload.
- Delete a photo → remaining photos compacted, deleted file gone.
- Navigate to a book item detail page → no photo controls visible.
- Upload a photo for a clothing item via the app → file appears in `data/photos/<item_id>/`.
- Restart the app and reload the clothing item → photo is still there and appears in the gallery (persistence test).
**Depends on**: Step 16a (inventory page must exist), Step 8 (GET /api/items/[id]), Step 10 (POST/PATCH /api/items/[id]/photos), Step 11 (DELETE), Step 12 (GET photo bytes to serve gallery)
**Parallelizable**: Yes — can be built in parallel with 16b/16d once 16a and routes exist.

### Step 16d: Extend Dashboard with per-category breakdown UI
**What**: Extend `components/Dashboard.tsx` to render the new `by_category` breakdown block (counts and acquisition costs per category, plus held totals).
**Files**: `components/Dashboard.tsx`
**Test**: 
- View the dashboard after creating 2 book items (acquisition_cost = 1000 each) and 1 clothing item (acquisition_cost = 2500).
- Verify by_category.book shows count=2, acquisition_cost=2000; by_category.clothing shows count=1, acquisition_cost=2500.
- Verify held_count = 3 and held_acquisition_cost = 4500.
**Depends on**: Step 16a (inventory page must exist), Step 13 (GET /api/dashboard returns per-category data)
**Parallelizable**: Yes — can be built in parallel with 16b/16c once 16a and routes exist.

### Step 17: Delete legacy app/api/books/** and app/books/** entirely
**What**: Run a `find` or `ls -la` command to confirm all files under `app/api/books/` and `app/books/` are no longer needed (because app/api/items/** and app/inventory/** now replace them entirely), then delete both directories. Do not leave any old routes or pages behind for backward compatibility — they are fully replaced.
**Files**: `app/api/books/` (delete directory), `app/books/` (delete directory)
**Test**: 
- Confirm via `ls` or `find` that `app/api/books/` and `app/books/` directories no longer exist.
- Run `npm run build` to confirm the app builds successfully without these paths.
- Verify no lingering imports or references to the deleted routes exist in other files (will be caught by the grep in Step 22).
**Depends on**: Steps 16a-16d (all new UI pages are verified working), Steps 6-12 (all new routes are verified working)
**Parallelizable**: No — this is a cleanup step after feature completion.

### Step 18a: Update integration tests with clothing and book scenarios
**What**: Extend `tests/integration.test.ts` to add test cases for: adding a book item and a clothing item, transitioning a clothing item through the status state machine, uploading/reordering/deleting photos for clothing, rejecting clothing conditions on book items and vice versa, mixed-category CSV import/export, and dashboard per-category breakdown. Explicitly re-run and verify existing book scenarios still pass (AC: book data unchanged, no regression).
**Files**: `tests/integration.test.ts`
**Test**: 
- Run `npm test` → all tests pass, including new clothing scenarios and existing book scenarios (no regression).
- Condition cross-validation: POST a book item with condition "EUC" (clothing-only) → 422 validation error; POST a clothing item with condition "Very Good" (book-only) → 422.
**Depends on**: Steps 6-12 (all API routes implemented)
**Parallelizable**: No — tests verify completed features.

### Step 18b: Create lib/__tests__/clothing.test.ts
**What**: Write unit tests for clothing-specific validation: `validateWeightOz(value)` (accepts non-negative integers, rejects negatives and non-integers), clothing condition enum (NWT, NWOT, EUC, GUC, Fair), and measurement field validation.
**Files**: `lib/__tests__/clothing.test.ts`
**Test**: 
- Test `validateWeightOz(42)` returns true; `validateWeightOz(-1)`, `validateWeightOz(3.5)`, `validateWeightOz("abc")` all return false or throw.
- Test condition-enum membership: 'EUC' ∈ CLOTHING_CONDITIONS, 'Very Good' ∉ CLOTHING_CONDITIONS.
**Depends on**: Step 4 (lib/clothing.ts must exist)
**Parallelizable**: No — tests verify completed code.

### Step 18c: Update lib/__tests__/transitions.test.ts with clothing-category cases
**What**: Add clothing-category transition cases to `lib/__tests__/transitions.test.ts` exercising a clothing-category item through the same transition table as books (Unlisted→Listed→Sold, etc.), and explicitly assert the existing book transition test cases are unchanged/still passing. Prove category-blindness (FR11, AC6): the transition rules are identical whether the item is a book or clothing.
**Files**: `lib/__tests__/transitions.test.ts`
**Test**: 
- Add cases: transition a clothing item Unlisted → Listed → Sold (sale_price, sale_date, sale_platform immutable).
- Re-run existing book transition cases and confirm all still pass (no regression).
- Assert that both category transitions follow the same rules (category-blind state machine).
**Depends on**: Step 4 and item schema (Step 2)
**Parallelizable**: No — tests verify completed code.

### Step 19: Verify data/photos/ directory exists and is persistent
**What**: Confirm `data/photos/` directory is created as part of Step 1c, with a `.gitkeep` file so the directory is tracked. Verify `.gitignore` does not exclude the directory itself.
**Files**: `data/photos/` (verify from Step 1c), `.gitignore` (verify)
**Test**: 
- `ls -la data/photos/` should succeed and show `.gitkeep`.
- Grep `.gitignore` for `photos` → no wildcard pattern excludes it (e.g., no `data/**/` patterns that would exclude it).
**Depends on**: Step 1c (directory created)
**Parallelizable**: Yes.

### Step 20: Migration safety checkpoint — back up live DB and dry-run the migration
**What**: Before running the app against the live `data/inventory.db`, manually back it up (`cp data/inventory.db data/inventory.db.pre-multi-category-backup` or use `lib/backup.ts` snapshot), then start the app once against a test copy to verify the migration runs to completion and the final schema is correct. Do NOT apply the migration to the live DB until this checkpoint is passed and the owner has reviewed the backup.
**Files**: None (verification step only)
**Test**: 
- Backup exists: `ls -la data/inventory.db.pre-multi-category-backup` succeeds.
- Copy the live DB: `cp data/inventory.db test-live-copy.db`.
- Start the app with `DATABASE_URL=test-live-copy.db npm run dev` (or adjust per the app's config) and let it boot.
- Migration runs: logs show successful `user_version` update to 3, or `001_init.sql` and `003_multi_category.sql` applied.
- Verify final schema on test copy: `sqlite3 test-live-copy.db ".tables"` shows correct tables, no `books` or old `book_platforms`.
- Verify data integrity: `SELECT COUNT(*) FROM items WHERE category='book'` matches pre-migration book count.
- Confirm the owner has reviewed the backup and the dry-run results before deleting the test copy and proceeding to live deployment.
**Depends on**: All prior steps (schema, API, UI complete and tested)
**Parallelizable**: No — this is a gate for live deployment.

### Step 21: Deploy to live database and verify migration success
**What**: Start the app normally with the live `data/inventory.db` present. The versioned-migration runner applies the migration on boot (since `user_version < 3`), moving all book data to the new items/book_details/... schema. Monitor for any errors; if the migration succeeds, spot-check a few book items to confirm data integrity.
**Files**: None (application run)
**Test**: 
- Start the app: `npm run dev`.
- Check logs for successful migration messages (or absence of migration-related errors).
- Query the live DB post-boot: `sqlite3 data/inventory.db "SELECT COUNT(*) FROM items WHERE category='book';"` should match the pre-migration book count.
- Load the `/inventory` page in the browser and verify all pre-existing book items are visible with correct data (title, author, condition, status, price, etc.).
- Click into a book item detail page → all fields are populated, photos array is empty (as expected for books).
- Verify the backup file `data/inventory.db.pre-multi-category-backup` is safe and can be deleted once the owner confirms the live deployment is stable.
**Depends on**: Step 20 (backup and dry-run passed)
**Parallelizable**: No — live deployment comes last.

### Step 22: Update any remaining codebase references to old table/API names
**What**: Run the grep command to find any lingering references not covered by the route rewrites and table renames: `grep -rn "book_platforms\|FROM books\|JOIN books\|book_id" app/ lib/ tests/ --include="*.ts" --include="*.tsx"`. Update them to use the new names (`item_platforms`, `items`, `item_id`) or delete them if the old code paths are superseded (e.g., legacy `app/api/books/**` routes deleted in Step 17).
**Files**: Any files matching the grep results
**Test**: 
- Run the grep again and confirm zero results (or only results in comments/docs explaining the old schema).
- Run `npm test` and `npm run build` → no TypeScript errors related to undefined tables or functions.
**Depends on**: All prior steps (to ensure rewrites are complete)
**Parallelizable**: No — completeness verification.

## Rollback plan

**Steps 1–17**: All reversible via `git checkout -- .` (never touch the live DB before step 20). Undo step 1 by deleting `data/migrations/003_multi_category.sql`.

**Step 20 (dry-run migration on test copy)**: Delete the test copy (`rm test-live-copy.db`). The live DB remains untouched.

**Step 21 (live migration)**: **ONLY REVERSIBLE IF BACKUP EXISTS.** If the migration fails or data is lost, restore from `data/inventory.db.pre-multi-category-backup` (`mv data/inventory.db data/inventory.db.corrupted && cp data/inventory.db.pre-multi-category-backup data/inventory.db`). The versioned-runner will not re-run the migration (version gate), so restart the app against the restored DB — it boots with the old schema. Revert all code changes to `git checkout -- .` and rebuild the app. Once stable, troubleshoot the migration failure, fix the code, and re-execute from step 20 on a fresh test copy.

If the backup is missing or the live DB is corrupted with no backup, the inventory data is unrecoverable — this is the non-negotiable change-control risk (step 20 checkpoint enforces a backup before ever touching the live DB).

---

**Summary:** 28 steps total (1a, 1b, 1c, 2–15, 16a–16d, 17, 18a–18c, 19–22). Parallelizable steps: 1c, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16b, 16c, 16d, 19 (17 total, organized into dependency chains for efficient parallel execution).
