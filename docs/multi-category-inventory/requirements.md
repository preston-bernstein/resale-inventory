# Requirements: Multi-Category Inventory (Clothing)

## Problem statement

The resale-inventory app's inventory schema and UI are hard-coded to a single category (books): one enum for condition, one satellite-free table shape, no photo model, no shipping-weight field. The operator now also resells clothing, which needs its own attributes (brand, size, material, garment measurements, a different condition vocabulary, multiple photos, shipping weight) that do not fit the books schema without corrupting it. Without this feature, clothing inventory has no structured record at all, and every category added after clothing would otherwise force a repeat of whatever one-off hack absorbs clothing today. This feature generalizes the schema and app to support clothing as a second category while keeping every base and book-specific field value, status, and platform listing identical before and after migration, and structures the design so a third category is additive rather than a rebuild.

## Users / stakeholders

- **Owner / operator** — the sole user; sources both books and clothing, sets prices, fulfills orders, tracks P&L across categories.
- **[Secondary market platforms]** — downstream consumers of listing data for both categories; source of inbound sale events (unchanged from the existing book spec).

## Functional requirements

1. The system shall generalize the existing books-only schema into a category-agnostic `items` table holding id, category discriminator, title/name, status, acquisition_cost, acquisition_date, listing_price, sale_price, sale_date, sale_platform, created_at, and updated_at, with all existing status/money CHECK constraints and invariants preserved unchanged.
2. The system shall support exactly two category values at initial release, `book` and `clothing`, assigned at item-creation time and immutable thereafter (no category change after creation).
3. The system shall persist book-specific fields (isbn, author, publisher, and the book condition enum) in a `book_details` satellite table keyed by item_id.
4. The system shall persist clothing-specific fields (brand, size_label, color, material, gender_department, weight_oz, and garment measurements — pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in) in a `clothing_details` satellite table keyed by item_id.
5. The system shall treat all eight garment measurement fields (pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in, leg_opening_in, hip_in) as optional at creation; if provided, each value must be a non-negative real number representing inches, and the system shall reject any negative or non-numeric value with a validation error.
6. The system shall enforce clothing condition using a fixed vocabulary independent of the book condition vocabulary: New with Tags (NWT), New without Tags (NWOT), Excellent Used (EUC), Good Used (GUC), Fair.
7. The system shall continue to enforce the existing book condition vocabulary unchanged for book items: Poor, Acceptable, Good, Very Good, Like New.
8. The system shall reject a condition value that does not belong to the item's own category vocabulary (e.g., a clothing-vocabulary value submitted for a book item, or vice versa) with a validation error; this check shall be keyed off the item's current/existing category as stored on the item record, not any category value that may appear in the request body (relevant for PATCH/edit requests).
9. The system shall allow the operator to add a clothing item by entering brand, size_label, condition, acquisition_cost, and acquisition_date (all required), plus color and material (both optional), without requiring an ISBN-style lookup step.
10. The system shall store size_label as free text exactly as entered by the operator; the system shall not normalize, validate against, or map size_label to any external or universal sizing scale.
11. The system shall store gender_department as free text exactly as entered by the operator; like size_label, the system shall not normalize, validate against, or map gender_department to any fixed vocabulary.
12. The system shall allow the operator to record weight_oz as a non-negative integer number of ounces on a clothing item; the field is optional at creation and editable while the item's status is not Sold.
13. The system shall apply the existing status state machine (Unlisted → Listed → Sale Pending → Sold, with terminal Removed/Donated/Discarded, and the exact transition set already enforced for books) identically to items of every category.
14. The system shall allow the operator to upload one or more photos for a clothing item, storing each photo on the local filesystem (no third-party/cloud storage) and recording one row per photo in an `item_photos` table with item_id and sort_order.
15. The system shall allow the operator to reorder or remove photos for a clothing item; the operator-defined order shall be preserved and returned on subsequent reads.
16. The system shall not require photos for book items and shall not surface a photo upload control on the book add/edit flow; `item_photos` is not exercised by book items in this feature.
17. The system shall replace the existing `book_platforms` table with a category-agnostic `item_platforms` table of the same shape (id, item_id, platform, listed_at); existing multi-platform-listing behavior shall continue to work unchanged for book items and shall also apply to clothing items.
18. The system shall maintain price_history (the existing price-change audit trail) identically for items of both categories, with no category-specific bypass path; every existing book item's price_history rows shall be preserved unchanged through the schema migration.
19. The system shall allow the operator to search/filter inventory by category (exact match: book or clothing), combinable with the existing filters (title/name substring match, status exact match, and the condition vocabulary appropriate to the selected category).
20. The system shall display, on the summary dashboard, item counts and total acquisition cost broken out per category, in addition to the existing combined totals across all categories.
21. The system shall include a category column and all category-specific columns in the CSV export; a row for an item of one category shall leave the other category's columns blank.
22. The system shall accept CSV import rows for either category in a single file, applying category-appropriate required-field validation (book rows require the existing book-required fields; clothing rows require brand, size_label, condition, acquisition_cost_usd, and acquisition_date, with color and material optional, consistent with the UI-add path), and shall report per-row errors without aborting the batch, consistent with existing import behavior.
23. The system shall preserve every existing book item's data (all base and book-specific field values, status, price history, and platform listings) unchanged through the schema migration that introduces the items/book_details/clothing_details split.
24. The system shall isolate all category-specific fields and CHECK constraints in per-category satellite tables, never on the `items` table or on other categories' satellite tables. This additivity claim does not cover the `items.category` CHECK constraint itself: extending that constraint to a third category value still requires one bounded rebuild of the `items` table alone (not the satellite tables), following the create-new-table/copy/drop/rename protocol referenced in the Constraints section.

## Non-functional requirements

- Photo storage must use the local filesystem only; no cloud or third-party storage dependency.
- Photo uploads are restricted to image file types, subject to a per-file size limit of [threshold TBD] and a per-item maximum photo count of [threshold TBD].
- Uploaded photo files on the local filesystem must persist durably across application restarts, with no loss, consistent with the existing NFR for database data durability.
- The schema migration must produce zero data loss for existing book rows: every base and book-specific field value, status, and platform listing must be identical before and after migration.
- The status state machine and money invariants (integer-cents fields, existing CHECK constraints) must hold identically for both categories; no category-specific bypass path may exist.
- Data (including new `clothing_details`, `item_photos`, and `item_platforms` rows) must be persisted to durable local storage with no loss on application restart, consistent with the existing book-data guarantee.
- Single-user system; no concurrent write contention requirement (unchanged from the existing book spec).

## Constraints

- Money stays integer cents, primary keys stay UUIDv4, and WAL + foreign-key pragmas remain unchanged.
- The status transition machine remains centralized in `lib/transitions.ts` as the single source of truth; it must not be duplicated or forked per category.
- SQLite cannot ALTER a CHECK constraint. Any change to an existing enum (book condition, clothing condition, or status) must follow the create-new-table/copy/drop/rename protocol defined by this repo's change-control regime (`.claude/skills/resale-inventory-architecture-contract`, `resale-inventory-change-control`); the migration mechanics themselves belong in plan.md, not this document.
- All existing book functional requirements (ISBN-based add with auto-lookup, condition tracking, status transitions, price history, CSV export/import, dashboard aggregates, search/filter — see `docs/book-inventory-management/requirements.md`) remain in force unchanged for the book category's data and behavior; this feature does not replace the existing spec's data model or behavioral guarantees. However, the API/UI route surface is consolidated as part of this same change: `app/api/books/**` and `app/books/**` become `app/api/items/**` and `app/inventory/**` respectively — this is a breaking path change for any downstream consumer, not an additional parallel surface.
- `book_platforms` is renamed to `item_platforms`; any existing code or query referencing `book_platforms` must be updated to the new name as part of this change.
- List/search, status-transition, and detail-page navigation for clothing must follow the same shape as the existing book flow; new UI elements strictly required by clothing-specific data (photo upload, measurement inputs) are permitted and are not a departure from this constraint.

## Out of scope

- Marketplace API integrations or auto-listing for clothing; listing remains manual, same as the existing book flow.
- Automated shipping label purchase.
- Size normalization across brands or platforms; size is stored as-entered text only.
- A fully generic N-category plugin/framework system; only book and clothing are built now, structured so a third category is additive.
- A shipping-cost estimator; only the weight_oz field and its capture is in scope, not any calculation built on it.
- "How to sell" educational content.
- Cloud or third-party photo storage.
- Marketplace-specific category taxonomy mapping (e.g., mirroring eBay's or Poshmark's category tree).

## Acceptance criteria

1. Given the schema migration runs against an existing books-only database, every pre-existing book row appears as an item with category `book`, the same id, and all base-field values (status, acquisition_cost, acquisition_date, listing_price, sale_price, sale_date, sale_platform, created_at, updated_at) unchanged; the corresponding `book_details` row carries the same isbn, author, publisher, and condition as before migration.
2. Given a pre-existing book item with status Sold, its status, sale_price, sale_date, and sale_platform are unchanged and the item remains fully queryable after migration.
3. Given an item has been created with category `book` (or `clothing`), an attempt to change its category via edit/PATCH is rejected with a validation error and the item's category is unchanged.
4. Given the operator adds a clothing item with brand, size_label, color, material, condition, acquisition_cost, and acquisition_date, the system creates an item with category `clothing` and status Unlisted, and persists the entered fields in `clothing_details`.
5. Given an attempt to set a clothing item's condition to a book-only value (e.g., "Very Good"), the system rejects the change with a validation error and the condition is unchanged.
6. Given an attempt to set a book item's condition to a clothing-only value (e.g., "EUC"), the system rejects the change with a validation error and the condition is unchanged.
7. Given a clothing item in Unlisted status with a listing_price set, the operator can transition it Unlisted → Listed → Sale Pending → Sold following the same rules already enforced for books; an attempt to transition Sold → Listed on a clothing item is rejected identically to the equivalent book case.
8. Given the operator uploads 3 photos for a clothing item in a specific order, all 3 are saved to the local filesystem, 3 rows appear in `item_photos` with item_id and sort_order matching the upload order, and reading the item returns the photos in that order.
9. Given the operator reorders or removes a photo on a clothing item, subsequent reads reflect the new order or absence of the removed photo.
10. Given the operator enters weight_oz as a non-negative integer on a clothing item, the value is stored and returned unmodified; given a negative or non-integer value is submitted, the system rejects it with a validation error.
11. Given a clothing item's status is Sold, an attempt to edit weight_oz (or any other clothing-specific field) is rejected, consistent with the existing terminal-status edit lock enforced for books.
12. Given a book item, the add/edit UI presents no photo upload control and no weight_oz field.
13. Given a full inventory export containing both book and clothing items, the CSV includes a category column and all category-specific columns; a book row's clothing-only columns are blank and a clothing row's book-only columns are blank.
14. Given a CSV import file containing both valid book rows and valid clothing rows, both import successfully with correct category assignment; given a row is missing a category-required field (e.g., a clothing row missing size_label), that row is reported as a per-row error and all other valid rows in the batch still commit.
15. Given the dashboard is loaded with both book and clothing items in inventory, it displays item counts and total acquisition cost broken out per category, and the combined totals equal the sum across both categories.
16. Given a search filtered to category `clothing`, only clothing items are returned; given the same search is combined with a clothing-only condition value, only matching clothing items are returned and no book items appear.
17. Given a book item and a clothing item are each listed on two platforms via `item_platforms`, both items' platform listings are recorded and retrievable identically, with no behavioral difference between the two categories.
</content>
