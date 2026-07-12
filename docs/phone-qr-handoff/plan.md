# Plan: Phone Handoff via QR Code

## Approach

A new `phone_pairing_tokens` SQLite table holds short-lived, server-generated tokens bound to one item id; a client-side QR renderer (`qrcode`, new dependency — none exists today) turns a token URL into a scannable code, with the tailnet origin derived from the *request's own* `Host` header and validated against an allowlist — the host must end in the Tailscale MagicDNS suffix `.ts.net`, or exactly match an operator-set `PUBLIC_ORIGIN` env var — rather than a blocklist of `localhost`/IP literals, and rather than any new Tailscale integration. This means an operator who reaches the app via a bookmarked LAN IP (not the tailnet hostname) will hit the "cannot determine origin" case every time; the desktop UI surfaces this as a clear, non-silent recovery message rather than failing invisibly (see `PhoneHandoff.tsx` below). The mobile view is a new unauthenticated page (`/phone/[token]`) that talks to two new thin endpoints and then uploads through the **existing** `app/api/items/[id]/photos/route.ts` POST handler, extended to accept an optional pairing-token header rather than duplicated. The desktop learns about new photos and phone-connection state via 3-second polling of a new per-item status endpoint — no SSE/websocket infrastructure, matching what's already in this stack.

Concrete values for this plan's TBD thresholds: **pairing token TTL = 15 minutes**, **desktop poll interval = 3 seconds** (photo appears within **5 seconds** of a successful phone upload), **QR/token issuance completes within 1 second** of the click (pure local DB write, no network call).

## Architecture

```
Desktop browser (tailnet origin)                Phone browser (tailnet origin)
        │                                                  │
        │ 1. POST /api/items/:id/phone-session             │
        │    (derives origin from Host header,             │
        │     allowlisted: *.ts.net or PUBLIC_ORIGIN)       │
        ├───────────────────────────────────────────────────┤
        │ 2. renders QR (client-side, qrcode lib)           │
        │    encoding <origin>/phone/<rawToken>              │
        │    + shows raw URL as copyable text                │
        │                                                     │
        │ 3. polls GET /api/items/:id/phone-session          │  4. scans QR, opens
        │    every 3s → {status, expires_at, photos[]}       │     /phone/<token>
        │    (stops on ended/expired or unmount)              │        │
        │                                                     │        ▼
        │                                                     │  GET /api/phone-session/:token
        │                                                     │  → {item: {id,title,brand,size}}
        │                                                     │  (marks first_accessed_at)
        │                                                     │        │
        │                                                     │        ▼
        │                                                     │  POST /api/items/:id/photos
        │                                                     │  header: X-Pairing-Token
        │                                                     │  (EXISTING endpoint, extended)
        │◄────────── DB write (item_photos) ─────────────────┴────────┘
        │
        │ next poll tick picks up new photo → onPhotosChange → gallery updates, no reload
        ▼
   phone_pairing_tokens + item_photos (SQLite, data/inventory.db)
```

Both desktop and phone are the same Next.js app reached via Tailscale Serve at the same origin — no cross-origin calls, so the existing CSRF (`middleware.ts` Origin-check) applies unchanged to both.

## Data model

New migration `data/migrations/004_phone_pairing_tokens.sql`, gated at `user_version = 4`, added to `VERSIONED_MIGRATIONS` in `lib/db.ts`. Tokens are persisted (survive restart) — an in-flight pairing is not silently lost, and the existing `runStartupBackup` routine already covers this table for free.

`created_at`, `expires_at`, and `first_accessed_at` are stored as **Unix epoch milliseconds (INTEGER)**, not text. SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` (space-separated, no `T`/`Z`) — labeling that "ISO-8601 UTC" is wrong, and comparing it against JS `Date` objects risks a silent timezone/parsing bug. Epoch-ms integers sidestep the whole string-format class of bug: every read/write in the API contract below uses `Date.now()` and plain integer comparisons.

```sql
CREATE TABLE phone_pairing_tokens (
  id                 TEXT    PRIMARY KEY                 -- UUIDv4
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  item_id            TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  token_hash         TEXT    NOT NULL UNIQUE              -- sha256(raw token), hex; raw token
                     CHECK (length(token_hash) = 64),      -- is returned to the caller once and
                                                            -- never stored (defense-in-depth: the
                                                            -- DB file is covered by the existing
                                                            -- startup backup, so plaintext tokens
                                                            -- shouldn't sit in it at rest)
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','ended')),
  created_at         INTEGER NOT NULL,                    -- epoch ms, set by app (Date.now())
  expires_at         INTEGER NOT NULL                     -- epoch ms, created_at + 15 min
                     CHECK (expires_at > created_at),
  first_accessed_at  INTEGER                               -- epoch ms, set on first successful GET
                     CHECK (first_accessed_at IS NULL       -- by the phone; NULL = "waiting",
                            OR first_accessed_at BETWEEN created_at AND expires_at)
                                                            -- non-NULL = "connected" (req 15)
);

-- Only one active token per item at a time (req 18), enforced at the DB layer
-- as defense-in-depth on top of the app-layer "end prior, then insert" logic
-- — same belt-and-suspenders pattern as items_category_immutable in
-- 003_multi_category.sql. token_hash is already UNIQUE above, which SQLite
-- auto-indexes, so no separate index on it is added here.
CREATE UNIQUE INDEX idx_ppt_item_active ON phone_pairing_tokens(item_id) WHERE status = 'active';

-- Supports the GET status-derivation query's "most recent row for this item"
-- fallback once ended/expired history accumulates between hygiene sweeps.
CREATE INDEX idx_ppt_item_created ON phone_pairing_tokens(item_id, created_at DESC);

-- Supports the hygiene delete below without a full table scan as history grows.
CREATE INDEX idx_ppt_expires_at ON phone_pairing_tokens(expires_at);
```

The item-creation path (end any existing active token for this item, then insert the new row) runs inside a single `db.transaction()` — as two separate statements this races under a double-click on "Continue on phone" (or a retried request) and can throw an unhandled `SQLITE_CONSTRAINT_UNIQUE` from the partial unique index instead of behaving as specified. Expiry is checked lazily (compare `expires_at` to `Date.now()` at read time) — no cron/background job. A one-line hygiene delete (`DELETE FROM phone_pairing_tokens WHERE expires_at < ?` bound to `Date.now() - 24*60*60*1000`) runs as part of the same transaction that ends the prior token and inserts the new one, so token creation stays one atomic unit and the table doesn't grow unbounded over months of daily use.

## API / interface contract

**`POST /api/items/[id]/phone-session`** — issue a pairing token (req 3–7, 18).
- 400 if `id` isn't a valid UUIDv4; 404 if item doesn't exist; 422 if `item.category !== 'clothing'` — via the shared load-item-and-verify-category helper (see Integration points), the same one the extended photos route uses.
- Derives the tailnet origin from `request.headers.get('host')`, validated against an allowlist: accepted only if the host ends in the Tailscale MagicDNS suffix `.ts.net`, or exactly matches the host portion of the `PUBLIC_ORIGIN` env var if the operator has set one. Any other host — `localhost`, an IP literal, a LAN hostname, an absent header, or a spoofed value — → **409** `{ error: 'Cannot determine a tailnet origin; open this app via its Tailscale Serve URL (…ts.net) to use phone handoff.' }` and issues no token (req 8). An operator who reaches the app via a bookmarked LAN IP will hit this 409 every time until they use the tailnet URL or set `PUBLIC_ORIGIN` — the desktop `PhoneHandoff` component renders this as an explicit `error` state, not a silent failure.
- On success: inside one `db.transaction()`, runs the hygiene delete, ends any existing active token for this item (`status='ended'`), and inserts a new row (`created_at = Date.now()`, `expires_at = created_at + 15*60*1000`) — the transaction prevents a double-click or retried request from racing the partial unique index into an unhandled constraint error. Returns `201 { url, expires_at }` where `url = "<origin>/phone/<rawToken>"` and `expires_at` is epoch ms. The raw token appears in this one response body only.

**`GET /api/items/[id]/phone-session`** — desktop poll target (req 14, 15).
- Returns `200 { status: 'none'|'waiting'|'connected'|'ended'|'expired', expires_at: number|null, photos: PhotoRow[] }`.
- `status` is derived via an explicit two-step query, not stored verbatim: first `SELECT * FROM phone_pairing_tokens WHERE item_id = ? AND status = 'active'`; if that returns no row, fall back to `SELECT * FROM phone_pairing_tokens WHERE item_id = ? ORDER BY created_at DESC LIMIT 1` (served by `idx_ppt_item_created`) to determine whether the last-known state was `ended` or `expired`. No row from either query → `none`. Given a row: `status='ended'` → `ended`; `Date.now() > expires_at` → `expired`; `first_accessed_at IS NULL` → `waiting`; else → `connected`.
- `photos` is the same shape the item detail page already renders, so the poller can feed it straight into `onPhotosChange`.

**`DELETE /api/items/[id]/phone-session`** — end session manually (req 16).
- Sets the item's active row to `status='ended'`. `204` whether or not one existed (idempotent). Gated only by item id — see Security notes.

**`GET /api/phone-session/[token]`** — mobile-facing token resolution (req 9, 10).
- Validates the `token` path param's shape (expected hex length matching the sha256 raw-token encoding) before any hashing or DB lookup; a malformed token gets the same generic 404 as below.
- Hashes the incoming token and looks up `token_hash` using a constant-time comparison (`crypto.timingSafeEqual`), not default string/DB equality. Not found, `status='ended'`, expired, or malformed → **404** `{ error: 'This link is no longer valid.' }` — the same generic message for every failure case, so responses never distinguish "not found" from "expired" from "ended" from "wrong item." No item data or the raw token appears in the body or in any log line (req 10).
- Otherwise sets `first_accessed_at = Date.now()` on first call, returns `200 { item: { id, title, brand, size_label }, expires_at }` (epoch ms) — identifying fields only, per req 9.

**`POST /api/items/[id]/photos`** — EXTENDED, not duplicated (req 11–13).
- New optional check inserted immediately after the existing category check (now the shared helper — see Integration points). This route re-validates category server-side regardless of whether the "Continue on phone" button was hidden client-side; client-side hiding is a UX nicety, hiding here would be a security control, not the other way around.
- If header `X-Pairing-Token` is present: validate its shape (hex length matching the sha256 digest) before hashing; hash it and compare against the stored `token_hash` with a constant-time comparison. Reject **401** `{ error: 'Invalid or expired pairing token.' }` — the same generic message whether the token wasn't found, belongs to a different item (`item_id` mismatch, req 12), has `status !== 'active'`, or is past expiry (`Date.now() > expires_at`, req 13) — checked at upload time, not just at page-open time.
- If the header is absent, behavior is byte-for-byte unchanged from today (desktop uploads keep working with zero regression). Everything after this check — content-type allowlist, magic-byte sniff, size cap, count cap, path-traversal containment, write-then-insert ordering — is untouched.

**`GET /phone/[token]`** — mobile page (not an API route; a Next.js page).
- `app/phone/[token]/page.tsx` is a client component using `'use client'` + `useParams()` — the pattern already used by `app/inventory/[id]/page.tsx` — not the `Promise<{params}>` pattern used in API route handlers.
- On mount, calls `GET /api/phone-session/[token]`. Error → renders an error view, no navigation, no other data (req 10). Success → renders item title/brand/size, a `<input type="file" accept="image/*" capture="environment" multiple>` + upload button that POSTs to `/api/items/${item.id}/photos` with the `X-Pairing-Token` header, reusing the existing `optimizeImageFile` client-side helper. No links to any other route in the app (req 9).
- Needs its own route-segment layout, `app/phone/layout.tsx`, that suppresses the app's normal navigation/chrome — Next.js App Router pages otherwise inherit the root layout.

## Security notes

- Never log the raw token, the `X-Pairing-Token` header value, or the full `/phone/[token]` URL in any `console.error`/logging call this feature adds.
- Token and header shape are validated before hashing or DB lookup (see API contract); every "not found"/"expired"/"ended"/"wrong item" failure returns the same generic error message so a response can't be used to distinguish which case occurred.
- Token-hash lookups use `crypto.timingSafeEqual` rather than default string/DB equality — cheap to add, closes a low-severity timing gap.
- `GET`/`DELETE /api/items/[id]/phone-session` are intentionally gated only by item id, consistent with this entire app's existing no-account/trust-the-Tailscale-network security model (requirements.md's Constraints explicitly forbid introducing new accounts or session concepts) — this is a deliberate consistency choice, not a gap, and should not be "fixed" with per-operation ownership checks.
- The token's 256 bits of entropy is the primary defense against guessing; no additional rate-limiting is added for this version, consistent with the corresponding NFR in requirements.md.

## Integration points

- `data/migrations/004_phone_pairing_tokens.sql` — new migration, schema above.
- `lib/db.ts` — add `{ version: 4, file: '004_phone_pairing_tokens.sql' }` to `VERSIONED_MIGRATIONS`.
- `lib/pairingToken.ts` (new) — `createToken(itemId)`, `resolveToken(rawToken)`, `endActiveToken(itemId)`, `getSessionStatus(itemId)`; centralizes hashing (`crypto.createHash('sha256')`), the constant-time compare, and expiry-window math so both the session routes and the extended photos route share one implementation. Also exports `loadClothingItemOrThrow(itemId)` — the shared "load item, verify `category === 'clothing'`, else throw the 404/422" helper used by both `phone-session` POST and the extended photos route, so the two 422 paths can't drift apart.
- `lib/tailnetOrigin.ts` (new) — `resolveTailnetOrigin(request): string | null`, the `Host`-header allowlist check described above (accepts hosts ending in `.ts.net`, or matching `PUBLIC_ORIGIN` if set; rejects everything else, including `localhost` and IP literals).
- `app/api/items/[id]/phone-session/route.ts` (new) — POST/GET/DELETE handlers above.
- `app/api/phone-session/[token]/route.ts` (new) — GET handler above.
- `app/api/items/[id]/photos/route.ts` — extend POST with the pairing-token header check (5–10 line addition right after the existing category check, using the shared helper); PATCH handler untouched.
- `app/phone/[token]/page.tsx` (new) — mobile capture view, `'use client'` + `useParams()`.
- `app/phone/layout.tsx` (new) — route-segment layout suppressing the app's normal chrome/navigation for everything under `/phone`.
- `components/PhoneHandoff.tsx` (new) — desktop "Continue on phone" panel with state machine idle → QR-shown-waiting → connected → ended, plus an explicit `error` state (triggered by the 409 "origin undetermined" response or any network/5xx failure) rendering recovery text (e.g. "Open this app via its Tailscale address to use phone handoff."). The raw pairing URL is shown as selectable/copyable text alongside the QR image, as a fallback for scan failures or cameraless devices. The polling `setInterval` is cleared on unmount and stops once status becomes `ended` or `expired` — not left running for the remainder of the 15-minute TTL. Each poll's `photos[]` is threaded into the item detail page's existing gallery state via the same `onPhotosChange` callback pattern `PhotoUpload` already uses, not held only in local component state.
- `app/inventory/[id]/page.tsx` — render `<PhoneHandoff itemId={item.id} onPhotosChange={onPhotosChange} />` next to `<PhotoUpload>` inside the existing `item.category === 'clothing' && <PhotosSection .../>` conditional (line ~402) — same gating PhotoUpload already uses, so req 1/2 fall out of existing structure with no new conditional logic to get wrong.
- `package.json` — add `qrcode` (+ `@types/qrcode` dev dep).
- `package-lock.json` — generated by `npm install`, tracks dependency tree for reproducible installs.
- `docs/PHONE-ACCESS.md` — this file already exists; edit it to add a cross-reference section pointing at this feature (not a new file).

## Technology choices

- **`qrcode`** (npm) — the standard, dependency-free QR encoder for JS; used client-side (`QRCode.toDataURL`) so no server-side image generation or new server dependency is needed. No existing QR capability in this repo, and hand-rolling QR encoding is not a reasonable alternative.
- **3-second polling via `setInterval` + `fetch`**, not SSE/websockets — the repo has zero existing push infrastructure, this is a single-user LAN app where a few seconds of staleness is acceptable per the requirements' own non-functional threshold, and polling needs no persistent-connection handling across Turbopack dev-server reloads or `next start` restarts. Simplest thing that satisfies req 14.
- **Node's built-in `crypto`** (`randomBytes`, `createHash`, `timingSafeEqual`) for token generation/hashing/comparison — no new dependency, matches the "cryptographically random, unguessable" requirement directly (32 bytes = 256 bits).

## Risk areas

- **Tailnet-hostname allowlist**: origin detection allowlists by `.ts.net` suffix or an explicit `PUBLIC_ORIGIN` env var, rather than blocklisting only `localhost`/IP literals — this closes the spoofed/misrouted-Host-header origin-injection gap, but means an operator who reaches the app via a bookmarked LAN IP will hit the 409 case every time until they switch to the tailnet URL or set `PUBLIC_ORIGIN`. It's still worth a manual check against the real deployed tailnet URL before calling req 7/8 done — if Tailscale Serve ever proxies with a rewritten Host, the allowlist would reject a legitimate request.
- **Timestamp storage**: `created_at`, `expires_at`, and `first_accessed_at` are epoch-ms integers specifically to avoid the SQLite `datetime('now')` (space-separated, no `T`/`Z`) vs. JS `Date` string-comparison bugs this pattern has caused elsewhere. Both migration and API contract use `Date.now()`/plain integer arithmetic throughout — no string-format conversion anywhere in this table's lifecycle.
- **"Connected" false-positive**: `first_accessed_at` is set on the *first* successful `GET /api/phone-session/[token]`, so a phone's link-preview fetch or an OS QR-scanner's pre-fetch (not a user action) could flip the desktop indicator to "phone connected" before the operator actually reaches the capture view. Cosmetic risk only — it doesn't affect token validity or upload authorization — but worth confirming isn't confusing in practice.
- **Navigate-away decision (req 17)**: resolved as *accept natural expiry, no auto-invalidation on desktop navigation*. Reliable "operator left the page" detection (`beforeunload`/`visibilitychange`) doesn't fire consistently across mobile/desktop browsers and tab-close vs. navigate-within-app aren't reliably distinguishable, so building it would be unreliable defense masquerading as real security. The 15-minute TTL plus the manual "End session" button (req 16) plus the one-active-token-per-item invalidation (req 18) are judged sufficient given the token is already a secondary layer on top of Tailscale network access.
- **Poll load with the panel left open**: if an operator opens "Continue on phone" and walks away without scanning or ending the session, polling continues only until the session reaches `ended`/`expired` status or the component unmounts — both are explicit stop conditions for the `setInterval` in `PhoneHandoff.tsx` (see Integration points), so it no longer runs unconditionally for the full 15-minute TTL.
- **Test coverage**: this repo enforces 85/80/85/85 coverage thresholds (per README) plus Stryker mutation testing. Every new file/route this feature adds — `lib/pairingToken.ts`, `lib/tailnetOrigin.ts`, the three new route handlers, `PhoneHandoff.tsx`, `app/phone/[token]/page.tsx` — needs accompanying unit tests, not just the manual verification implied by the API contract examples above.
