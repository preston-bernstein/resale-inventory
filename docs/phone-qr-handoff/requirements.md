# Requirements: Phone Handoff via QR Code

## Problem statement

Photographing a clothing item requires a phone camera, but the operator does the rest of inventory work (adding items, setting prices, managing status) at a desktop. Today the only way to get phone-taken photos into the app is the documented Tailscale Serve path (`docs/PHONE-ACCESS.md`), which requires the operator to manually open the tailnet URL on the phone, navigate to the right item, upload, then return to the desktop and reload to see the result. This feature collapses that manual hop: the operator clicks "continue on phone" on an item they're already viewing, scans a QR code, and the phone opens directly to that item's photo-capture view — with new photos appearing on the desktop without a manual refresh. It matters now because clothing is the one category where photos are the highest-leverage listing input, and the current handoff friction discourages using the phone camera at all.

## Users / stakeholders

- **Operator** — the sole user; initiates handoff from desktop, takes photos on phone, verifies results back on desktop.
- **[Secondary market platforms]** — indirect beneficiary; better photos improve listing quality, no direct integration.

## Functional requirements

1. The system shall display a "Continue on phone" action on the item detail view, only for items in the clothing category.
2. The system shall NOT display the "Continue on phone" action for non-clothing items (e.g., books), consistent with the existing photo-upload category restriction in `app/api/items/[id]/photos/route.ts`.
3. When the operator selects "Continue on phone," the system shall request a new pairing token from the server, scoped to the current item id.
4. The system shall generate each pairing token as a cryptographically random value, unguessable by sequential or brute-force enumeration.
5. The system shall bind each pairing token server-side to exactly one item id and record its creation timestamp.
6. The system shall set each pairing token to expire 15 minutes after creation, after which it is no longer accepted for any request.
7. The system shall render a QR code encoding a URL that includes the tailnet-served origin (not `localhost` or `127.0.0.1`) and the pairing token.
8. The system shall NOT render a QR code, and shall show an explanatory message instead, if the app cannot determine its own tailnet-served origin (e.g., accessed directly via `127.0.0.1` rather than through Tailscale Serve).
9. The system shall, when a phone opens the QR-encoded URL with a valid, unexpired pairing token, present a mobile-optimized view (a single-column layout usable one-handed at phone screen widths, with the camera/upload control reachable without scrolling) scoped to the bound item — showing the item's identifying details (e.g., title/description) and a camera-capture/upload control, with no other inventory data or navigation exposed.
10. The system shall, when a phone opens the QR-encoded URL with an invalid, expired, or superseded pairing token, display an error view and shall not expose any item data.
11. The system shall accept photo uploads from the paired mobile view by submitting to the existing `app/api/items/[id]/photos/route.ts` POST endpoint for the bound item, subject to that endpoint's existing validation (magic-byte sniffing, size cap, per-item count cap, path-traversal defense).
12. The system shall require every upload request from the paired mobile view to present the pairing token, and shall reject uploads whose token does not match the item id being uploaded to.
13. The system shall reject an upload request from the paired mobile view if the pairing token has expired since the mobile view was opened.
14. The system shall update the desktop/web session's photo view for the bound item automatically when a new photo is uploaded from the paired phone, without requiring the operator to manually refresh or navigate away and back.
15. The system shall visually indicate, on the desktop item view while a pairing token for that item is active, that a phone session is paired (e.g., "phone connected") and shall update that indicator when the phone session ends or the token expires.
16. The system shall allow the operator to end the paired session manually from the desktop, immediately invalidating the pairing token for further use.
17. The system shall NOT invalidate a pairing token when the operator navigates away from the item on the desktop before the phone has scanned it (reliable navigate-away/tab-close detection is not attempted). The token remains valid until natural expiry (15 minutes after creation, per FR6), a manual "End session" action (FR16), or supersession by a new token request for the same item (FR18). This decision is also recorded in the Constraints section.
18. The system shall allow only one active pairing token per item at a time; requesting a new "continue on phone" QR code for an item with an already-active, unexpired token shall invalidate the prior token and issue a new one.
19. The system shall NOT create any persistent account, credential, or identity for the phone; the paired mobile view is accessible to any device that possesses the valid token URL, matching the trust model of the underlying Tailscale network.
20. The system shall re-validate, server-side, that the item's category is clothing when a pairing token is requested, independent of whether the client-side "Continue on phone" control was hidden for that item.
21. The phone view shall display success or failure feedback to the operator after each upload attempt.

## Non-functional requirements

- The pairing token must not be derivable from the item id, sequential counters, or any other predictable value.
- A photo uploaded from the paired phone must appear in the desktop view within 5 seconds of a successful upload response, without manual refresh.
- QR code generation and pairing-token issuance must complete within 1 second of the operator clicking "Continue on phone."
- No new third-party network dependency: QR generation and the desktop-update channel must run entirely within the existing local Next.js app, with no external service reachable from outside the Tailscale network.
- This is a single-user, non-concurrent, LAN-local feature; no requirement for supporting multiple simultaneous paired phones across different users, high request concurrency, or horizontal scaling.
- The pairing token is a secondary authorization layer on top of Tailscale network-level access control; it must not be usable to reach the app from outside the tailnet, and it must not weaken or replace the existing localhost-binding/Tailscale-only access model.
- The raw pairing token value, the `X-Pairing-Token` header value, and the full `/phone/[token]` URL must never be written to application logs, error trackers, or any persisted log store.
- The pairing token's 256-bit random entropy is relied upon as the primary defense against guessing/brute-force; given the single-user, LAN-only (Tailscale-only) threat model, no additional rate-limiting is required for this feature's first version.

## Constraints

- Must reuse the existing photo upload endpoint (`app/api/items/[id]/photos/route.ts`) and its existing validation rather than duplicating upload logic in a new endpoint.
- Must respect the existing clothing-only photo restriction; this feature does not lift that restriction. Extending photo support to other categories is a separate decision, out of scope here.
- The QR-encoded URL must use the tailnet-served origin, per the existing `docs/PHONE-ACCESS.md` access model — the app itself continues to bind to `127.0.0.1` only.
- No existing websocket/SSE infrastructure exists in this stack; the desktop-update mechanism (polling or a push channel) is an implementation choice made in the design/plan phase, not mandated here, but whichever is chosen must not require a new external service.
- No user accounts or login system exists in this app and this feature must not introduce one.
- Single-file SQLite via `better-sqlite3` is the existing persistence layer; pairing tokens must be persisted so that an active token remains valid across a server restart (no in-memory-only option).
- The system does not attempt to detect or act on desktop navigate-away/tab-close; a pairing token is not invalidated when the operator navigates away from the item before the phone scans it. The token remains valid until natural expiry (15 minutes), a manual "End session" action, or supersession by a new token request for the same item (see FR17, FR18).
- Deleting an item must not be blocked by an existing pairing-token row (active or ended) for that item; associated pairing-token rows are removed automatically when the item is deleted.

## Out of scope

- Lifting the clothing-only restriction on photo uploads for other item categories.
- Phone-side account creation, login, or any persistent phone identity.
- Supporting multiple simultaneous paired phone sessions for the same item.
- Access from outside the operator's Tailscale network (this feature does not add internet-facing exposure).
- Editing item fields other than photos from the paired mobile view (price, status, description, etc.).
- Offline support on the phone view (no service worker/offline queue for uploads).
- Push notifications to the phone or desktop outside the browser tab itself.
- Batch or multi-item capture within a single phone session; each pairing token and each phone session is scoped to exactly one item, matching the one-token-per-item data model.

## Acceptance criteria

1. Given a clothing item on the desktop item detail view, when the operator clicks "Continue on phone," the system displays a QR code encoding a tailnet-origin URL with a pairing token within 1 second.
2. Given a books-category item, the "Continue on phone" action is not present on its detail view.
3. Given a QR code generated for item A, when scanned by a phone within the pairing token's validity window, the phone opens a view scoped only to item A with a camera-capture/upload control and no other inventory data.
4. Given an expired pairing token, when a phone opens the encoded URL, the system displays an error and exposes no item data.
5. Given a phone paired to item A, when the operator uploads a photo from the phone, the upload passes through the existing validation in `app/api/items/[id]/photos/route.ts` (rejecting oversized files, non-image content, and files beyond the per-item cap identically to a desktop upload).
6. Given a successful phone upload for item A, the desktop view already open on item A displays the new photo within 5 seconds without the operator reloading the page.
7. Given an active pairing token for item A, when the operator requests a new "Continue on phone" QR code for item A, the prior token no longer authorizes uploads and a new token/QR code is issued.
8. Given an active pairing token for item A, when the operator clicks "end phone session" on the desktop, subsequent upload attempts using that token are rejected.
9. Given the app is accessed at `127.0.0.1` directly (not via Tailscale Serve), the "Continue on phone" flow does not render a QR code under any circumstance and instead shows the explanatory message from FR8; no `localhost`/`127.0.0.1` URL is ever encoded into a QR code.
10. Given a pairing token bound to item A, an upload request presenting that token but targeting item B's upload endpoint is rejected.
11. Given the app process restarts while a pairing token is active, the system's behavior matches whatever was decided in the Constraints section (either the token still works or is cleanly invalidated) — no undefined/crashing behavior either way.
12. Given a valid token issued for item A, a different randomly-generated token string of the same length and format does not resolve to item A or to any other item.
13. Given an active pairing token for item A that has not yet been opened by a phone, the desktop shows a "waiting" state; once the phone successfully opens the paired URL, the desktop indicator updates to a "connected" state without a manual refresh.
