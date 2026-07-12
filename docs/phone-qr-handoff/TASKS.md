# Tasks: Phone Handoff via QR Code

Generated from: docs/phone-qr-handoff/ on 2026-07-12

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Database migration — add `phone_pairing_tokens` table
**Status**: [x] done
**Files**: data/migrations/004_phone_pairing_tokens.sql, lib/db.ts
**Test**: Run migration; verify table+indexes exist via sqlite3 .schema; attempt double-insert of active token for same item_id, verify unique-constraint violation; add Vitest test.
**Depends on**: none
**Parallelizable**: no
**Notes**:

### Task 2: Create token generation and validation library
**Status**: [x] done
**Files**: lib/pairingToken.ts
**Test**: createToken/resolveToken/endActiveToken behavior verified; Vitest test added.
**Depends on**: Task 1
**Parallelizable**: no
**Notes**:

### Task 3: Create tailnet origin detection library
**Status**: [x] done
**Files**: lib/tailnetOrigin.ts
**Test**: resolveTailnetOrigin allowlists *.ts.net / PUBLIC_ORIGIN, rejects localhost/IP literals/other hosts; Vitest test added.
**Depends on**: none
**Parallelizable**: yes
**Notes**:

### Task 4a: Create phone-session POST endpoint (issue token)
**Status**: [x] done
**Files**: app/api/items/[id]/phone-session/route.ts
**Test**: POST clothing item → 201 {url, expires_at}; non-clothing → 422; origin undetermined → 409; re-POST invalidates prior token; Vitest test added.
**Depends on**: Tasks 2, 3
**Parallelizable**: no
**Notes**:

### Task 4b: Create phone-session GET endpoint (poll status)
**Status**: [x] done
**Files**: app/api/items/[id]/phone-session/route.ts
**Test**: GET returns status/expires_at/photos derived correctly across none/waiting/connected/ended/expired; Vitest test added.
**Depends on**: Tasks 2, 3
**Parallelizable**: no
**Notes**: Same file as 4a — implement sequentially.

### Task 4c: Create phone-session DELETE endpoint (end session)
**Status**: [x] done
**Files**: app/api/items/[id]/phone-session/route.ts
**Test**: DELETE → 204 idempotent; subsequent GET reflects ended; Vitest test added.
**Depends on**: Tasks 2, 3
**Parallelizable**: no
**Notes**: Same file as 4a/4b — implement sequentially.

### Task 5: Create phone token resolution endpoint
**Status**: [x] done
**Files**: app/api/phone-session/[token]/route.ts
**Test**: valid token → 200 + item data; invalid/expired/malformed → uniform 404, no item data; repeated call keeps first_accessed_at stable; Vitest test added.
**Depends on**: Task 2
**Parallelizable**: yes
**Notes**:

### Task 6: Extend photo upload endpoint with pairing-token validation
**Status**: [x] done
**Files**: app/api/items/[id]/photos/route.ts
**Test**: valid token → 201; invalid/mismatched/expired token → 401; header absent → unchanged desktop behavior; Vitest test added.
**Depends on**: Task 2
**Parallelizable**: yes
**Notes**:

### Task 8: Create mobile-optimized phone view + route layout
**Status**: [x] done
**Files**: app/phone/[token]/page.tsx, components/SiteChrome.tsx, app/layout.tsx
**Test**: valid token → item details + camera input, no app chrome; upload succeeds via extended endpoint; invalid token → error, no item data; Vitest test added.
**Depends on**: Tasks 2, 5, 6
**Parallelizable**: no
**Notes**: CORRECTED during build — app/phone/layout.tsx cannot suppress root-layout chrome in Next.js (nested layouts only wrap children, can't remove ancestor markup). Fixed via components/SiteChrome.tsx (client component, hides header when pathname starts with /phone) used from app/layout.tsx instead. qrcode dependency moved to Task 9a (the actual QR-rendering consumer). Also fixed a pre-existing bug in tests/phone-pairing-tokens.test.ts (Task 1's own test file) — its beforeEach only deleted phone_pairing_tokens+items, missing the satellite tables (item_photos, price_history, item_platforms, clothing_details, book_details) that this repo's FK convention requires deleting first; fixed to match tests/api/items-photos.test.ts's established cleanup order. Full suite now 39/39 files, 727/727 tests passing.

### Task 9a: Desktop PhoneHandoff component — QR rendering and init
**Status**: [x] done
**Files**: components/PhoneHandoff.tsx
**Test**: button → QR renders on success; 409/network failure → error state; Vitest test added.
**Depends on**: Tasks 4a, 8
**Parallelizable**: no
**Notes**:

### Task 9b: Desktop PhoneHandoff component — polling and end-session
**Status**: [x] done
**Files**: components/PhoneHandoff.tsx
**Test**: 3s poll updates status/photos; End session → DELETE + reset; interval cleared on unmount/terminal status; Vitest test added.
**Depends on**: Tasks 9a, 4b, 4c
**Parallelizable**: no
**Notes**: Same file as 9a — implement sequentially.

### Task 10: Integrate PhoneHandoff into item detail page + docs
**Status**: [x] done
**Files**: app/inventory/[id]/page.tsx, docs/PHONE-ACCESS.md
**Test**: clothing item → panel renders; non-clothing → no panel; phone photo appears in desktop gallery within 5s; docs cross-reference readable; Vitest test added.
**Depends on**: Tasks 6, 8, 9b
**Parallelizable**: no
**Notes**:

## Blocked / open
(populated during implementation)
