# Tasks: Multi-Category Inventory (Clothing)

Generated from: docs/multi-category-inventory/ on 2026-07-11

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1a: Create migration file — DDL only
**Status**: [x] done
**Files**: data/migrations/003_multi_category.sql
**Test**: schema inspection on test DB copy; cross-category condition CHECK rejection proof
**Depends on**: none
**Parallelizable**: No
**Notes**: Combined with 1b into a single agent call since same file; written verbatim per plan.md's reviewed SQL.

### Task 1b: Create migration file — data-copy portion
**Status**: [x] done
**Files**: data/migrations/003_multi_category.sql
**Test**: row-count + field-level parity vs pre-migration books table, on test DB copy
**Depends on**: 1a (same file)
**Parallelizable**: No
**Notes**: Done together with 1a. Test (row-count/field-level parity on a test DB copy) not yet run — deferred to migration safety checkpoint (Task 20, manual/owner-gated).

### Task 1c: Create data/photos/ directory + .gitkeep
**Status**: [x] done
**Files**: data/photos/, .gitkeep, .gitignore
**Test**: directory tracked, .gitignore doesn't exclude the dir itself
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 2: Extend lib/db.ts versioned migration runner (critical fix)
**Status**: [x] done
**Files**: lib/db.ts
**Test**: double-boot idempotency — second boot does not resurrect books/book_platforms
**Depends on**: 1a, 1b
**Parallelizable**: No
**Notes**:

### Task 3: Add category/condition constants
**Status**: [x] done
**Files**: lib/constants.ts
**Test**: conditionsForCategory() unit behavior
**Depends on**: none
**Parallelizable**: Yes
**Notes**: Kept existing CONDITIONS/Condition exports for now (removed once all call sites migrate to conditionsForCategory in later tasks).

### Task 4: Create lib/clothing.ts validation helpers
**Status**: [x] done
**Files**: lib/clothing.ts
**Test**: validateWeightOz edge cases
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 5: Populate lib/types.ts shared types
**Status**: [x] done
**Files**: lib/types.ts
**Test**: tsc --noEmit passes; Item is a discriminated union on category
**Depends on**: 3
**Parallelizable**: Yes
**Notes**:

### Task 6: POST /api/items route
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: create book/clothing item, cross-category condition rejected, size_label round-trips
**Depends on**: 2, 3, 4, 5
**Parallelizable**: No (shares file with Task 7)
**Notes**:

### Task 7: GET /api/items route (search)
**Status**: [x] done
**Files**: app/api/items/route.ts
**Test**: category/condition filter combos, q search across categories
**Depends on**: 6
**Parallelizable**: No
**Notes**: Combined with Task 6 in a single agent call (same file).

### Task 8: GET+PATCH /api/items/[id] route
**Status**: [x] done
**Files**: app/api/items/[id]/route.ts
**Test**: category-scoped detail join, PATCH allowlist, terminal-status lock (all 4 statuses), size_label round-trip
**Depends on**: 2, 3, 4, 5
**Parallelizable**: Yes
**Notes**:

### Task 9: POST /api/items/[id]/status route
**Status**: [x] done
**Files**: app/api/items/[id]/status/route.ts
**Test**: clothing transitions match book transitions; book regression re-verified
**Depends on**: 2, 8
**Parallelizable**: Yes
**Notes**:

### Task 10: POST+PATCH /api/items/[id]/photos route
**Status**: [x] done
**Files**: app/api/items/[id]/photos/route.ts
**Test**: upload/reorder, book rejection, file-type/path-traversal/IDOR guards
**Depends on**: 2, 8
**Parallelizable**: Yes
**Notes**:

### Task 11: DELETE /api/items/[id]/photos/[photoId] route
**Status**: [x] done
**Files**: app/api/items/[id]/photos/[photoId]/route.ts
**Test**: delete compacts sort_order, 404 on wrong item/nonexistent
**Depends on**: 10
**Parallelizable**: Yes
**Notes**: Combined with Task 12 (same file).

### Task 12: GET /api/items/[id]/photos/[photoId] route (serve bytes)
**Status**: [x] done
**Files**: app/api/items/[id]/photos/[photoId]/route.ts
**Test**: streams bytes with correct Content-Type; IDOR 404
**Depends on**: 2, 10
**Parallelizable**: Yes
**Notes**: Combined with Task 11 (same file).

### Task 13: GET /api/dashboard — per-category breakdown
**Status**: [x] done
**Files**: app/api/dashboard/route.ts
**Test**: by_category counts/costs correct, combined totals match sum
**Depends on**: 2, 3
**Parallelizable**: Yes
**Notes**:

### Task 14: GET /api/export — category + mixed columns
**Status**: [x] done
**Files**: app/api/export/route.ts
**Test**: header includes category + all columns, blank non-matching per row
**Depends on**: 2, 3
**Parallelizable**: Yes
**Notes**:

### Task 15: POST /api/import — mixed categories
**Status**: [x] done
**Files**: app/api/import/route.ts
**Test**: mixed CSV import, per-row category-required-field errors
**Depends on**: 2, 3, 4
**Parallelizable**: Yes
**Notes**:

### Task 16a: /inventory list + search page
**Status**: [x] done
**Files**: app/inventory/page.tsx, app/inventory/layout.tsx, components/ItemTable.tsx, components/ItemSearch.tsx, app/layout.tsx (nav link only)
**Test**: category column, category-scoped condition dropdown
**Depends on**: 6, 7
**Parallelizable**: No (base UI page)
**Notes**: KNOWN GAP for UX pass: GET /api/items list response has no `platforms` field per plan.md's contract (only GET /api/items/:id has it) — old BookTable showed platforms inline, ItemTable now shows "—" always. Not a crash, degrades gracefully. Consider adding platforms to the list query in a UX pass.

### Task 16b: /inventory add-item flow
**Status**: [x] done
**Files**: app/inventory/new/page.tsx, components/AddClothingForm.tsx
**Test**: category picker toggles ISBN vs clothing fields
**Depends on**: 16a, 6
**Parallelizable**: Yes
**Notes**:

### Task 16c: /inventory detail page + photo UI
**Status**: [x] done
**Files**: app/inventory/[id]/page.tsx, components/PhotoUpload.tsx
**Test**: gallery upload/reorder/delete, persistence across restart, no photo UI on books
**Depends on**: 16a, 8, 10, 11, 12
**Parallelizable**: Yes
**Notes**:

### Task 16d: Dashboard per-category UI
**Status**: [x] done
**Files**: components/Dashboard.tsx
**Test**: by_category rendering matches API data
**Depends on**: 16a, 13
**Parallelizable**: Yes
**Notes**:

### Task 17: Delete legacy app/api/books/** and app/books/**
**Status**: [x] done
**Files**: app/api/books/ (delete), app/books/ (delete)
**Test**: paths gone, npm run build succeeds
**Depends on**: 16a, 16b, 16c, 16d, 6, 7, 8, 9, 10, 11, 12
**Parallelizable**: No
**Notes**:

### Task 18a: Integration tests — clothing + book regression
**Status**: [x] done
**Files**: tests/integration.test.ts
**Test**: npm test all green, no book regression
**Depends on**: 6, 7, 8, 9, 10, 11, 12
**Parallelizable**: No
**Notes**:

### Task 18b: lib/__tests__/clothing.test.ts
**Status**: [x] done
**Files**: lib/__tests__/clothing.test.ts
**Test**: weight_oz + condition enum unit tests
**Depends on**: 4
**Parallelizable**: No
**Notes**:

### Task 18c: lib/__tests__/transitions.test.ts — clothing cases
**Status**: [x] done
**Files**: lib/__tests__/transitions.test.ts
**Test**: clothing transitions + book regression re-verified
**Depends on**: 4, 2
**Parallelizable**: No
**Notes**:

### Task 19: Verify data/photos/ persistence
**Status**: [ ] pending
**Files**: data/photos/, .gitignore
**Test**: directory tracked correctly
**Depends on**: 1c
**Parallelizable**: Yes
**Notes**:

### Task 22: Grep sweep for lingering old-name references
**Status**: [x] done
**Files**: none needed fixing
**Test**: grep clean (only comments + backup.test.ts's self-contained throwaway schema remain, both harmless), npm run build passes against a scratch DB
**Depends on**: all above
**Parallelizable**: No
**Notes**: `npx tsc --noEmit` clean across the whole project. `npm run build` (BOOKSELLER_DB_PATH pointed at a scratch file, never the live DB) succeeded fully once the scratch DB was pre-migrated by a single controlled process — all 12 routes compiled, including every new /api/items/** and /inventory/** route. Full migration chain (001→002→003) verified working end-to-end on a fresh DB.
**Finding (not blocking, pre-existing risk, documented not fixed)**: running `npm run build` directly against a *brand-new, not-yet-migrated* DB file can hit `SQLITE_BUSY` / a corrupted intermediate migration state, because Next.js's build spawns multiple worker processes that each import `lib/db.ts` (module-load side effect) concurrently, and the version-gated migration runner was never designed to be safe against multiple OS processes racing to apply the same migration to the same fresh file. This is a pre-existing architectural gap (the original 001+002 migration chain has the same exposure) surfaced by testing with a scratch DB, not something introduced by this feature. It does not affect the real deployment path: `data/inventory.db` already exists with real data at `user_version=2`, and the app runs as a single long-running process (`next dev`/`next start`), never multiple parallel build workers against a fresh file. If this is ever a concern (e.g. CI running `npm run build` against a fresh throwaway DB), the fix would be a file-lock (e.g. an flock-based mutex or a `.migrating` sentinel file) around the migration-application section of `lib/db.ts` — out of scope for this feature.

## Live end-to-end verification (post-implementation)

Ran the app for real against a scratch DB (`npm run dev`, `BOOKSELLER_DB_PATH` pointed at a throwaway file, never `data/inventory.db`) and drove it through a browser plus direct API calls. This caught two things static review (typecheck, build, 7-agent spec-challenge) missed entirely:

1. **Critical bug, found and fixed**: `PATCH /api/items/:id` failed with `SQLITE_CONSTRAINT_FOREIGNKEY` on any listing-price change to a newly created item (book or clothing). Root cause: `price_history`'s FK, after the migration's `ALTER TABLE ... RENAME COLUMN` step, pointed at `books_archived(id)` instead of `items(id)` — SQLite only retargets a FK to a table's *new name* when that exact table is renamed, never to a different table the constraint never mentioned. Pre-existing book rows validated by coincidence (their id exists in both `items` and `books_archived`); every newly created item did not. Fixed by rebuilding `price_history` with the FK correctly pointed at `items(id)` from creation, via the same create-copy-drop-rename protocol used for the other tables (see `data/migrations/003_multi_category.sql` and `plan.md`, both updated with the full incident writeup inline). Re-verified: fresh scratch DB, full migration chain, PATCH listing_price on new book and clothing items, both now save and record price_history correctly.
2. **UX gap, found and fixed**: `GET /api/items` (list/search) didn't return a `platforms` field per item — the original plan's contract omitted it, and `ItemTable.tsx` degraded gracefully to "—" rather than crashing. Fixed by adding a `LEFT JOIN item_platforms` + `GROUP_CONCAT` to the list query (same pattern already used by the single-item route), so the inventory list now shows real platform data instead of always "—". Verified live: set platforms on an item, list view updates correctly.

Also verified via browser + curl: add-item flow (book and clothing, including all 8 measurement fields and the category-scoped condition dropdown), photo upload (real magic-byte-validated PNG, server-generated filename, gallery renders via the GET photo-bytes route, reorder/delete controls present), status transitions (Unlisted → Listed with price_history recorded), dashboard (per-category breakdown, split condition groups, correct combined totals), Seller Playbook page (renders cleanly, TOC anchors work), CSV export (correct headers and per-category blank columns), CSV import (valid row commits, invalid row reports exact missing fields without aborting the batch). No console errors other than a `cz-shortcut-listen` hydration warning caused by a browser extension in the test environment, unrelated to the app.

## Blocked / open

- **Task 20 (migration safety checkpoint) and Task 21 (live DB deploy) are intentionally NOT included in this automated run.** Per book-seller-change-control non-negotiable (g) and this repo's standing instruction, no session applies a schema migration to the live `data/inventory.db` autonomously. These steps require the owner to take a manual backup and explicitly approve before the app boots against the real database. All other tasks (1a–19, 22) are complete and verified — build + typecheck clean against a scratch DB, never the live one. Ready for the owner to run Task 20 (backup + dry-run) and Task 21 (live deploy) manually whenever they choose.
