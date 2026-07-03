# Tasks: Book Inventory Management

Generated from: docs/book-inventory-management/ on 2026-07-01

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Initialize Next.js 15 project and install dependencies
**Status**: [x] done
**Files**: package.json, package-lock.json, tsconfig.json, next.config.ts, tailwind.config.ts, postcss.config.js, app/layout.tsx, app/globals.css, .gitignore
**Test**: Run `npm run dev`; verify Next.js dev server starts on localhost:3000 and loads without errors.
**Depends on**: none
**Parallelizable**: no
**Notes**: 

### Task 2: Set up SQLite database connection and schema
**Status**: [x] done
**Files**: lib/db.ts, data/migrations/001_init.sql
**Test**: Make a test API request (e.g., `curl http://localhost:3000/api/books`) after starting dev server; then verify data/inventory.db exists and contains the expected schema: `sqlite3 data/inventory.db '.schema'`.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: 

### Task 3: Implement utility modules
**Status**: [x] done
**Files**: lib/transitions.ts, lib/money.ts, lib/isbn.ts, lib/__tests__/transitions.test.ts, lib/__tests__/money.test.ts, lib/__tests__/isbn.test.ts
**Test**: Write unit tests; verify Unlisted→Listed allowed, Listed→Sold→Listed rejected, cent conversion handles edge cases, ISBN lookup returns title/author/publisher or times out after 3s.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: 

### Task 4: Implement ISBN lookup API endpoint
**Status**: [x] done
**Files**: app/api/isbn/[isbn]/route.ts
**Test**: `curl http://localhost:3000/api/isbn/9780765326355`; verify response includes title, author, publisher; test with invalid ISBN returns 400; verify timeout after 3s.
**Depends on**: Tasks 1, 3
**Parallelizable**: yes
**Notes**: 

### Task 5: Implement book creation API
**Status**: [x] done
**Files**: app/api/books/route.ts
**Test**: POST with ISBN → returns book with auto-populated fields, Unlisted status, UUIDv4 id; POST with manual fields → inserts without ISBN lookup; POST invalid condition → 422 error; verify acquisition_cost stored as integer cents.
**Depends on**: Tasks 1, 2, 3
**Parallelizable**: no
**Notes**: 

### Task 6: Implement book retrieval and list APIs
**Status**: [x] done
**Files**: app/api/books/route.ts, app/api/books/[id]/route.ts
**Test**: GET /api/books → returns {items, total, page, limit}; GET /api/books?limit=10&page=0 → pagination works; GET /api/books/[valid-uuid] → returns book; GET /api/books/[invalid-uuid] → 404.
**Depends on**: Tasks 1, 2, 5
**Parallelizable**: no
**Notes**: Corrected from steps.md (was "Depends on: 1, 2" — shares app/api/books/route.ts with Task 5, must run after).

### Task 7: Implement search and filtering
**Status**: [x] done
**Files**: app/api/books/route.ts
**Test**: GET /api/books?title=test → case-insensitive partial match; GET /api/books?status=Sold → filter by status; GET /api/books?condition=Good&status=Listed → combined filters; empty result returns {items: [], total: 0}.
**Depends on**: Task 6
**Parallelizable**: no
**Notes**: 

### Task 8: Implement book update API
**Status**: [x] done
**Files**: app/api/books/[id]/route.ts
**Test**: PATCH with new listing_price → creates price_history entry; PATCH Sold item → 409 error; PATCH with new platforms (array) → updates book_platforms rows; verify previous_price and new_price both recorded.
**Depends on**: Tasks 1, 2, 3, 6
**Parallelizable**: yes
**Notes**: platforms must be string[] (junction table), not comma-sep string. Reject updates to Sold/Removed/Donated/Discarded items.

### Task 9: Implement status transition API
**Status**: [x] done
**Files**: app/api/books/[id]/status/route.ts
**Test**: Sale Pending→Sold with sale data → status updates, sale fields stored; Sale Pending→Sold without sale_price → 422; Sold→Listed → 422 "Transition Sold → Listed is not permitted."; update updated_at on each transition.
**Depends on**: Tasks 1, 2, 3
**Parallelizable**: no
**Notes**: gross_profit is NOT stored — computed at read time via SQL. Do NOT write gross_profit to DB.

### Task 10: Implement dashboard aggregation API
**Status**: [x] done
**Files**: app/api/dashboard/route.ts
**Test**: Use POST /api/books to seed 5 Unlisted + 5 Sold books; GET /api/dashboard → held_count=5, held_acquisition_cost=sum of 5 held only; by_status.Sold=5; by_status.Unlisted=5.
**Depends on**: Tasks 1, 2
**Parallelizable**: yes
**Notes**: "held" = status IN ('Unlisted','Listed','Sale Pending'). Excludes Sold, Removed, Donated, Discarded.

### Task 11: Implement CSV export API
**Status**: [x] done
**Files**: app/api/export/route.ts
**Test**: POST 3 books (1 Sold); GET /api/export → CSV download; verify all column headers; check Sold row gross_profit_usd = (sale_price - acquisition_cost)/100 as "0.00"; formula injection cells prefixed with tab.
**Depends on**: Tasks 1, 2
**Parallelizable**: yes
**Notes**: gross_profit computed via SQL (sale_price - acquisition_cost), divided by 100 for USD display. Prefix =, +, -, @ cells with tab. Join book_platforms for platforms column.

### Task 12: Implement CSV import API
**Status**: [x] done
**Files**: app/api/import/route.ts
**Test**: Upload 50-row CSV (48 valid, 2 missing required fields) → {imported: 48, errors: [{row: N, fields: [...], message: "..."}]}; upload >10 MB → 413; verify sale-related columns ignored (items always Unlisted).
**Depends on**: Tasks 1, 2, 3
**Parallelizable**: yes
**Notes**: Required columns: title, author, condition, acquisition_cost_usd, acquisition_date. All imported items created as Unlisted regardless of status column in CSV.

### Task 13: Set up frontend layout and core pages
**Status**: [x] done
**Files**: app/layout.tsx, app/page.tsx, app/books/layout.tsx, app/dashboard/layout.tsx, app/globals.css
**Test**: Navigate to /; landing page loads with links to /books and /dashboard; Tailwind styles render; nav structure present.
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**: 

### Task 14: Implement add book form and book detail page
**Status**: [x] done
**Files**: app/books/add/page.tsx, app/books/[id]/page.tsx, components/AddBookForm.tsx
**Test**: /books/add: valid ISBN → auto-populate; invalid ISBN → manual entry; submit → book created, redirect to /books. /books/[id]: all fields displayed; update listing_price → price history row appears; status transition dropdown works; Sold item shows gross_profit.
**Depends on**: Tasks 1, 5, 8, 9
**Parallelizable**: yes
**Notes**: 

### Task 15: Implement inventory listing page
**Status**: [x] done
**Files**: app/books/page.tsx, components/BookTable.tsx, components/BookSearch.tsx
**Test**: Load /books → table shows books; filter by title → results update; combine condition+status filters; pagination next/prev works with 25+ books.
**Depends on**: Tasks 1, 6, 7
**Parallelizable**: yes
**Notes**: 

### Task 16: Implement dashboard page
**Status**: [x] done
**Files**: app/dashboard/page.tsx, components/Dashboard.tsx
**Test**: Load /dashboard → 4 metric sections display correct values; add a new book via API → refresh /dashboard → held_count increases by 1.
**Depends on**: Tasks 1, 10
**Parallelizable**: yes
**Notes**: Display metric counts only — NO charts/graphs. Requirements say counts only.

### Task 17: End-to-end integration testing and refinement
**Status**: [x] done
**Files**: tests/integration.test.ts
**Test**: Run `npx vitest run tests/integration.test.ts`; all tests pass.
**Depends on**: Tasks 1–16
**Parallelizable**: no
**Notes**: 

## Blocked / open
(populated during implementation)

### Task 18: Fix constraint-leak 500 cluster (D1, D2, D3)
**Status**: [x] done (2026-07-03)
**Files**: app/api/books/[id]/status/route.ts, app/api/books/[id]/route.ts, app/api/import/route.ts, tests/integration.test.ts, docs/book-inventory-management/requirements.md, docs/book-inventory-management/plan.md
**Change**: D1 — POST status→Listed/Sale Pending without listing_price now returns 422 (was 500). D2 — CSV import with a duplicate ISBN (in-file or vs-DB) now reports a per-row error and still imports the other valid rows in one transaction (was 500, whole batch lost). D3 (discovered via code reading, confirmed live 2026-07-03) — PATCH listing_price:null on a Listed/Sale Pending item now returns 422 (was 500). All three routes also gained defense-in-depth SqliteError `.code` mapping (CHECK→422, UNIQUE→409). Spec updated first: requirements.md FR22 (extended), FR23, FR24, AC12, AC13; plan.md API contract for the three routes plus the Security section's error-message-safety bullet (previously mandated blanket 500 for all DB exceptions — now distinguishes known-invariant validation from genuine unexpected errors).
**Test**: `npm run build` green (13 routes). Scratch-copy suite (procedure B): 139 passed | 18 skipped. HTTP-level regression probes against a live server, each matching a stated prediction before running (see book-seller-failure-archaeology D1/D2/D3 entries for transcripts). 3 new regression tests added to the `describe.skip` HTTP suite in tests/integration.test.ts (D1, D2, D3 in test names); verified passing by temporarily un-skipping in a disposable scratch copy against an isolated server, then discarded (suite remains skipped in the committed tree, per book-seller-validation-and-qa). db-integrity.sh clean; api-smoke.sh all PASS.
**Depends on**: Task 17
**Parallelizable**: no
**Notes**: Executed per book-seller-constraint-leak-campaign in an isolated git worktree (never touched the real inventory.db). Two pre-existing, unrelated defects were discovered incidentally while activating the HTTP suite for verification — D4 (POST status Sold response omits gross_profit) and DR-8 (AC9 test's CSV header doesn't match the import schema) — both recorded in book-seller-failure-archaeology as OPEN and left unfixed; out of scope for this task.

### Task 19: Dedupe VALID_CONDITIONS and DATE_RE into lib/constants.ts
**Status**: [x] done (2026-07-03)
**Files**: lib/constants.ts (new), app/api/books/route.ts, app/api/books/[id]/route.ts, app/api/books/[id]/status/route.ts, app/api/import/route.ts, app/api/dashboard/route.ts, components/AddBookForm.tsx, components/BookSearch.tsx, components/Dashboard.tsx, app/books/[id]/page.tsx
**Change**: Non-behavioral refactor. Added `lib/constants.ts` exporting `CONDITIONS` (+ `Condition` type) and `DATE_RE` as the single source of truth. Replaced all 8 TS/TSX homes of the condition vocabulary (was 9, including the SQL CHECK) and all 3 homes of the date regex (was 3, one previously inline in app/api/import/route.ts) with imports from `lib/constants.ts`, most aliased to their prior local names (`VALID_CONDITIONS`, `ALL_CONDITIONS`) to keep the diff to import lines only. The SQL CHECK constraint in `data/migrations/001_init.sql` is intentionally left duplicated — per book-seller-config-and-constants, changing it requires the table-rebuild migration protocol (book-seller-change-control §4), which is a schema-migration-class change out of scope here.
**Test**: `npm run build` green (13 routes; one transient `SQLITE_BUSY` on first attempt, resolved on retry, unrelated to this change — collecting page data races opening the WAL DB from multiple workers). Scratch-copy suite (procedure B, book-seller-validation-and-qa): 139 passed | 18 skipped. HTTP smoke check against a scratch dev server (ports 3011/3012, never the real :3000/:3001): GET /api/dashboard and GET /api/books response bodies byte-identical in shape/order to pre-change baseline; POST /api/books with an invalid condition and an invalid date both still return `{"error":"Validation failed.","fields":[...]}` at 422 with the same field names. Real `data/inventory.db` row count confirmed 0 before and after (rejected payloads never write).
**Depends on**: Task 18
**Parallelizable**: no
**Notes**: Ranked #1 (condition, 9 homes) and #4 (date regex, 3 homes) drift risks in book-seller-config-and-constants' duplication map. Remaining known duplication after this task: status vocabulary + terminal/held derivations (lib/transitions.ts vs hand-copied TERMINAL/HELD_STATUSES/ALL_STATUSES/STATUS_TRANSITIONS), money cap (4 homes + tests), ISBN_PATTERN (2 homes) — none touched, out of scope.

### Task 20: Fix D4 (Sold response omits gross_profit) and DR-8 (AC9 test CSV header mismatch)
**Status**: [x] done (2026-07-03)
**Files**: app/api/books/[id]/status/route.ts, tests/integration.test.ts, docs/book-inventory-management/plan.md
**Change**: D4 — POST /api/books/:id/status's Sold-transition response now computes `gross_profit` (sale_price - acquisition_cost) at read time via the same `CASE WHEN b.status = 'Sold' ...` clause already used by GET/PATCH /api/books/:id, matching their response shape. Never stored (rule a). Spec updated first: plan.md's status-route API contract and file-map prose. DR-8 — the AC9 HTTP test's CSV header was `acquisition_cost`; renamed to `acquisition_cost_usd` to match `REQUIRED_FIELDS` and FR21's documented import schema (test-only fix, no route change).
**Test**: `npm run build` green (13 routes). Scratch-copy suite: 139 passed | 18 skipped (unchanged — both fixes land in the `describe.skip` HTTP suite). HTTP-level verification: temporarily un-skipped the suite in a disposable scratch copy against an isolated dev server (port 3005) — 92 passed | 1 skipped (only the network-only ISBN test remains skipped), confirming AC3 and AC9 both pass now. Suite discarded after; committed tree keeps it skipped per book-seller-validation-and-qa.
**Depends on**: Task 18 (discovered during its verification)
**Parallelizable**: yes (disjoint from Task 19)
**Notes**: Both defects were recorded OPEN in book-seller-failure-archaeology after Task 18; this task closes them out. failure-archaeology D4/DR-8 entries should be flipped to FIXED with this task cited as evidence.
