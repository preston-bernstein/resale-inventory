# Steps: Phone Handoff via QR Code

## Prerequisites

- Next.js app runs via Tailscale Serve at a tailnet origin (verified per `docs/PHONE-ACCESS.md`).
- SQLite database at `data/inventory.db` with existing `items` table and migrations infrastructure via `lib/db.ts`.
- Existing photo upload endpoint at `app/api/items/[id]/photos/route.ts` with category-based restrictions (clothing-only).
- Development environment: Node.js, npm, with `better-sqlite3` and Next.js already installed.

## Implementation steps

### Step 1: Database migration — add `phone_pairing_tokens` table
**What**: Create the SQLite schema for pairing tokens, with indexes and constraints to enforce one active token per item.
**Files**: `data/migrations/004_phone_pairing_tokens.sql`, `lib/db.ts`.
**Test**: Run `npm run db:migrate` (or the equivalent startup logic); verify `phone_pairing_tokens` table and indexes exist in `data/inventory.db` via `sqlite3 data/inventory.db ".schema phone_pairing_tokens"`. Attempt to insert two rows with `status='active'` for the same `item_id` and verify the second insert fails with a unique-constraint violation (proving the partial unique index `idx_ppt_item_active` actually works). Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: none.
**Parallelizable**: No.
**Rollback**: Delete the migration file and revert the line added to `VERSIONED_MIGRATIONS` in `lib/db.ts`.

### Step 2: Create token generation and validation library
**What**: Implement `lib/pairingToken.ts` with functions to generate cryptographically random tokens, hash them for storage, resolve tokens by hash, compute expiry, and check session status.
**Files**: `lib/pairingToken.ts`.
**Test**: Write a test file (or use Node REPL) to verify: `createToken(itemId)` returns an object with `token` and `tokenHash`; the token is 64 hex chars; `resolveToken(rawToken)` returns the row; expired tokens resolve to null; `endActiveToken(itemId)` marks status as 'ended'. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Step 1.
**Parallelizable**: No (depends on step 1 being complete so the DB schema is defined).
**Rollback**: Delete `lib/pairingToken.ts`.

### Step 3: Create tailnet origin detection library
**What**: Implement `lib/tailnetOrigin.ts` to parse the `Host` header from a Next.js request, reject `localhost` and IP literals, and return the tailnet origin or null.
**Files**: `lib/tailnetOrigin.ts`.
**Test**: Call `resolveTailnetOrigin(mockRequest)` with headers containing `Host: myapp.beta.tailscale.net`, `Host: localhost`, `Host: 127.0.0.1`, `Host: 192.168.1.1`; verify it returns the origin for the first, null for the rest. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: none.
**Parallelizable**: Yes (independent of step 2; can run in parallel).

### Step 4a: Create phone-session POST endpoint (issue token)
**What**: Implement the POST handler in `app/api/items/[id]/phone-session/route.ts` to create a pairing token and return session metadata, using the utilities from steps 2 and 3.
**Files**: `app/api/items/[id]/phone-session/route.ts`.
**Test**: Use curl or Postman: POST with clothing item id → returns 201 with `url` and `expires_at`; POST with non-clothing item → returns 422; subsequent POST for the same item invalidates the prior token and issues a new one. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 2, 3.
**Parallelizable**: No (depends on both utility steps).

### Step 4b: Create phone-session GET endpoint (poll status)
**What**: Implement the GET handler in `app/api/items/[id]/phone-session/route.ts` to poll session status and retrieve newly uploaded photos.
**Files**: `app/api/items/[id]/phone-session/route.ts`.
**Test**: GET with a valid item id → returns status, expires_at, and photos array; test with no active token → returns 404 or appropriate error. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 2, 3.
**Parallelizable**: No (same file as 4a, implement in sequence within one file).

### Step 4c: Create phone-session DELETE endpoint (end session)
**What**: Implement the DELETE handler in `app/api/items/[id]/phone-session/route.ts` to end the active pairing session.
**Files**: `app/api/items/[id]/phone-session/route.ts`.
**Test**: DELETE with a valid item id → returns 204; subsequent GET → returns 404 or indicates no active session. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 2, 3.
**Parallelizable**: No (same file as 4a, implement in sequence within one file).

### Step 5: Create phone token resolution endpoint
**What**: Implement `app/api/phone-session/[token]/route.ts` to verify a pairing token, set `first_accessed_at` on first access, and return item identifying details (id, title, brand, size_label).
**Files**: `app/api/phone-session/[token]/route.ts`.
**Test**: GET with a valid token → 200 with item data; GET with an expired or invalid token → 404 with no item data in response body; call twice with same token → second call returns same `first_accessed_at` as first. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Step 2.
**Parallelizable**: Yes (different file from step 4, same dependency on step 2).

### Step 6: Extend photo upload endpoint with pairing-token validation
**What**: Add an optional `X-Pairing-Token` header check to the POST handler in `app/api/items/[id]/photos/route.ts`, immediately after the existing category check; verify token matches the item id, is active, and not expired.
**Files**: `app/api/items/[id]/photos/route.ts`.
**Test**: Upload with a valid token → 201 and photo saved; upload with invalid token → 401; upload without token header → behaves as today (no regression); upload with token that doesn't match the item id → 401. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Step 2.
**Parallelizable**: Yes (different file from step 5, same dependency on step 2).

### Step 8: Create mobile-optimized phone view
**What**: Implement `app/phone/[token]/page.tsx` as a client component that calls `GET /api/phone-session/[token]` on mount, displays item title/brand/size, renders a camera/file-input control, and POSTs uploads to the existing photo endpoint with the `X-Pairing-Token` header. Add `app/phone/layout.tsx` as a route-segment layout that suppresses the app's normal navigation/chrome for everything under `/phone` (Next.js App Router pages otherwise inherit the root layout). Add `qrcode` and `@types/qrcode` to `package.json` and run `npm install`.
**Files**: `app/phone/[token]/page.tsx`, `app/phone/layout.tsx`, `package.json`, `package-lock.json`.
**Test**: Navigate to `/phone/<valid-token>` on a mobile browser → displays item details and camera input, no app nav/chrome visible; upload a test image → POST succeeds to `/api/items/[id]/photos` with token header (requires Step 6 to have validated the header); navigate to `/phone/<invalid-token>` → displays error, no item data. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 2, 5, 6.
**Parallelizable**: No (depends on steps 5 and 6 being complete).

### Step 9a: Create desktop phone-handoff component — QR rendering and token initialization
**What**: Implement the initial part of `components/PhoneHandoff.tsx` as a React component that displays a "Continue on phone" button on mount, calls POST `/api/items/[id]/phone-session` to get a token, uses the `qrcode` library to render a QR code (or shows an error message if origin detection fails with 409), and displays idle/waiting states.
**Files**: `components/PhoneHandoff.tsx`.
**Test**: Component test with mocked fetch to Step 4a (POST endpoint): render with a clothing item id → button appears; click → QR code renders; cancel the request or return 409 → error message displays instead. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 4a, 8.
**Parallelizable**: No (depends on steps 4a and 8 being complete).

### Step 9b: Create desktop phone-handoff component — polling and end-session
**What**: Extend `components/PhoneHandoff.tsx` to poll `GET /api/items/[id]/phone-session` every 3 seconds to track connection status and new photos, and display an "End session" button when a token is active. Include cleanup on unmount or terminal status.
**Files**: `components/PhoneHandoff.tsx`.
**Test**: Integration test against Steps 4b and 4c (GET and DELETE endpoints): with a valid token active, polling every 3 seconds retrieves status; new photo appears in the component's state; click "End session" → DELETE request sent and button resets. Also add a Vitest test file covering this behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 9a, 4b, 4c.
**Parallelizable**: No (builds on Step 9a and same file).

### Step 10: Integrate PhoneHandoff into item detail page and update documentation
**What**: Add the `<PhoneHandoff>` component to `app/inventory/[id]/page.tsx` inside the existing `item.category === 'clothing' && <PhotosSection .../>` conditional, next to the existing `<PhotoUpload>` component, wiring the `onPhotosChange` callback to update the gallery. Also add a brief note to `docs/PHONE-ACCESS.md` pointing to this feature as an alternative to the manual Tailscale Serve URL path for desktop-to-phone handoff.
**Files**: `app/inventory/[id]/page.tsx`, `docs/PHONE-ACCESS.md`.
**Test**: Navigate to a clothing item detail page → "Continue on phone" panel renders below the desktop upload control; navigate to a non-clothing item → panel does not render; new photos from the phone appear in the desktop gallery within 5 seconds of upload (requires full phone-upload path: Steps 6, 8, 9b). Verify `docs/PHONE-ACCESS.md` is readable and the link reference is clear. Also add a Vitest test file covering the integration behavior (see existing test patterns in the `tests/` directory for this repo's conventions).
**Depends on**: Steps 6, 8, 9b.
**Parallelizable**: No (depends on component from step 9b).

## Rollback plan

- **Steps 1–3**: Revert the file additions/deletions via git.
- **Steps 4a–4c**: Delete `app/api/items/[id]/phone-session/route.ts`.
- **Step 5**: Delete `app/api/phone-session/[token]/route.ts`.
- **Step 6**: Revert the 5–10 line addition to the POST handler in `app/api/items/[id]/photos/route.ts`.
- **Step 8**: Delete `app/phone/[token]/page.tsx` and `app/phone/layout.tsx`, and revert `qrcode` dependency from `package.json` via `npm uninstall qrcode @types/qrcode`.
- **Steps 9a–9b**: Delete `components/PhoneHandoff.tsx`.
- **Step 10**: Revert the import and component render in `app/inventory/[id]/page.tsx`, and revert doc additions to `docs/PHONE-ACCESS.md`.

For any step that touched the database, drop the `phone_pairing_tokens` table via `sqlite3 data/inventory.db "DROP TABLE phone_pairing_tokens;"` and revert `VERSIONED_MIGRATIONS` in `lib/db.ts`.

All steps are cleanly reversible via git.
