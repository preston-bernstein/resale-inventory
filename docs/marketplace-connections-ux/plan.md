# Plan: Marketplace Connections UX

## Approach

Build `/connections` as a single client-heavy page (matching `app/inventory/page.tsx`'s convention, not `app/dashboard/page.tsx`'s server-fetch-then-render convention) because the feature is a stateful, multi-step flow (empty state → connect cards → consent → credential → confirmation/first-win → status) that must be driven by client-side `fetch` calls so the network-call *ordering* itself is observable and testable (AC5, AC15). A small new read-only API route (`GET /api/connections/:id/first-win`) is required — not a data-model change, but an interface addition — because `checkConnectionHealth` lives in server-only `lib/connectors/*` modules (they import `playwright`, do encryption, etc.) that cannot execute in a client component; the six existing routes remain untouched and unmodified per the constraint. Everything else — trust-tier grouping, operability tier, per-platform risk copy, masked-identifier logic — is static client-side data/derivation layered over the existing API responses, exactly as the constraints direct.

## Architecture

```
app/connections/page.tsx (server component: cookie/session check, redirect to /login if absent — mirrors app/dashboard/page.tsx)
  └── components/connections/ConnectionsView.tsx ('use client', owns all state)
        │
        ├─ on mount: GET /api/connections  → ConnectionMetadata[]
        │
        ├─ discriminated-union `flow` state:
        │     { mode: 'list', cardsExpanded: boolean }           -- empty state OR cards+status; cardsExpanded folded into the union (no separate boolean — see Risk Areas)
        │   | { mode: 'consent', platform }                      -- disclosure fetch + affirm
        │   | { mode: 'credential', platform }                   -- field entry; carries no connectionId (see below — the id for a reconnect is only ever known after POST /api/connections responds, never before)
        │   | { mode: 'confirmed', platform, connectionId, maskedIdentifier }
        │
        ├─ components/connections/EmptyState.tsx        (flow.mode==='list' && connections.length===0 && !flow.cardsExpanded)
        ├─ components/connections/ConnectCardGrid.tsx   (flow.mode==='list' && (connections.length>0 || flow.cardsExpanded))
        │     └─ components/connections/ConnectCard.tsx × 8 (static SUPPORTED_PLATFORMS, grouped by tier)
        ├─ components/connections/StatusList.tsx        (renders alongside cards; one components/connections/StatusRow.tsx per existing connection)
        │     for each existing connection: fetch GET /api/connections/:id/consent → { has_valid_consent }
        │       (read-only; does not participate in the ordering-sensitive wizard sequence documented below)
        │       drives the blue "consent stale/missing" badge, AND detects the "active but never-consented"
        │       recovery case — an active connection with has_valid_consent:false routes the tenant back into
        │       flow=credential(platform) for THAT existing connection id, not a silent dead end
        ├─ components/connections/ConsentScreen.tsx     (flow.mode==='consent')
        │     fetch GET /api/disclosures/current on mount; explicit unchecked affirm control
        ├─ components/connections/CredentialStep.tsx    (flow.mode==='credential')
        │     on submit: POST /api/connections  →  POST /api/connections/:id/consent
        │     the :id in the consent call is always the id from the POST /api/connections response body —
        │     never a value carried in flow state from before the POST, even in the revoked-reconnect case
        │     (revoked-reconnect deletes the old row and creates a new one with a brand-new id; see API contract)
        └─ components/connections/ConnectionConfirmation.tsx (flow.mode==='confirmed')
              renders masked identifier (from local form state) +
              components/connections/FirstWinPanel.tsx
                    fetch GET /api/connections/:id/first-win on mount (NEW route)

app/api/connections/[id]/first-win/route.ts (NEW, GET, read-only)
  resolveOwnedConnection(existing helper, unmodified)
    → getConnector(connection.platform).checkConnectionHealth(tenantId, id)  [try/caught defensively]
      connection.platform is already validated against SUPPORTED_PLATFORMS at insert time by the existing
      POST /api/connections route; this route trusts that already-validated stored value and does no
      platform validation of its own
    → COUNT(items) for tenant NOT IN item_platforms for that platform, status='Unlisted' only  [new SQL, read-only]
  → { healthy, detail, readyCount }
```

Data flow for the connect-and-consent sequence (the ordering AC5/AC7/AC8/AC12 depend on):

```
ConnectCard click → flow=consent(platform)
  GET /api/disclosures/current                     [1st network call]
  tenant checks explicit affirm control (no network call)
  → flow=credential(platform)
CredentialStep submit (identifier + secret fields, identifier captured in local var)
  POST /api/connections { platform, credential }    [2nd network call — 201]
    (revoked-reconnect: identical request shape/route as a brand-new connection; the handler runs
    db.transaction(() => { deleteConnection(...); return createConnection(...) }), deleting the old
    revoked row and creating a brand-new row with a new UUID — this is the ONLY mechanism for
    revoked-reconnect, not PATCH /api/connections/:id/credential; see API/interface contract)
  → id taken from this response body, held in local state for the rest of this submit only
  POST /api/connections/:id/consent { disclosure_version }  [3rd network call, using that id]
    on 422 stale/invalid → re-fetch GET /api/disclosures/current, re-render
      ConsentScreen-style retry banner, retry ONLY the consent POST against
      the same connection id (never re-POST /api/connections — it now exists)
  → flow=confirmed(platform, connectionId, maskedIdentifier)
       renders masked identifier + FirstWinPanel in the same render
       FirstWinPanel: GET /api/connections/:id/first-win  [4th network call]
```

## Data model

No data model changes. The one new query (readiness count) is a `SELECT COUNT(*)` against existing tables (`items`, `item_platforms`), tenant-scoped, no new columns/tables/indexes:

```sql
SELECT COUNT(*) AS ready_count
FROM items i
WHERE i.tenant_id = ?
  AND i.status = 'Unlisted'
  AND NOT EXISTS (
    SELECT 1 FROM item_platforms ip
    WHERE ip.item_id = i.id AND ip.platform = ? AND ip.tenant_id = ?
  )
```

`i.status = 'Unlisted'` is required: `items.status` has 7 values (`Unlisted, Listed, Sale Pending, Sold, Removed, Donated, Discarded` per `003_multi_category.sql`) — without this filter the count would include Sold/Removed/Donated/Discarded items as "ready to list," which is wrong on the exact screen meant to build user trust. This is covered by the existing composite index `idx_items_tenant_status(tenant_id, status)` — no new index needed.

Implementation note: both `?` placeholders bound to tenant id (the outer `i.tenant_id = ?` and the inner `ip.tenant_id = ?`) must be bound from the exact same resolved-tenant variable (from `resolveOwnedConnection`) — never from two different sources (e.g. a session value vs. a route param). A mismatch would silently undercount rather than error loudly.

This query is category-agnostic and platform-agnostic by design — it counts all of a tenant's unlisted items regardless of whether the platform in question actually deals in that item's category (e.g. book items count toward a Grailed/Depop readiness number too). This is an accepted MVP simplification, not a bug to fix here — see Risk Areas.

`item_platforms` is already tenant-scoped (`006_tenant_scoping.sql`) and category-agnostic, so this is a single query with no join complexity across book/clothing satellite tables.

## API / interface contract

**Consumed exactly as shipped, no shape changes:**
- `GET /api/connections` → `ConnectionMetadata[]`
- `GET/POST /api/connections` (list / create — `POST` also handles the revoked→reconnect case: same request shape as a brand-new connection. The handler runs `db.transaction(() => { deleteConnection(...); return createConnection(...) })`, which deletes the old revoked row and creates a new row with a brand-new UUID. `PATCH /api/connections/:id/credential` is never involved in reconnect and cannot resurrect a revoked connection — see below.)
- `GET /api/connections/:id`
- `GET/POST/DELETE /api/connections/:id/consent` (the `GET` here is what `StatusRow` polls per-connection for `has_valid_consent`, per Architecture)
- `PATCH /api/connections/:id/credential` (re-encrypts credentials in place on an existing row and never touches `status`; used only for the "rotate password" case, not exposed as a separate UI per Out of Scope, and NOT used for revoked→reconnect)
- `POST /api/connections/:id/reactivate`
- `GET /api/disclosures/current`

**New route (additive only):**

`GET /api/connections/:id/first-win`
- Auth/ownership: `resolveOwnedConnection` (same helper every other `:id` route uses) → 404 on missing/cross-tenant, 401 if no session.
- Response 200: `{ healthy: boolean, detail?: string, readyCount: number }`
- `checkConnectionHealth` is wrapped in try/catch: some concrete connectors (e.g. Amazon, per `lib/connectors/__tests__/amazon.test.ts`) throw `ConnectorNotConfiguredError` when app-level env credentials are absent, despite the generic interface being documented as non-throwing. That specific case is mapped to `{ healthy: false, detail: 'connector not configured' }`. Any OTHER thrown error (database error, third-party API error, etc.) is mapped to a generic, safe `{ healthy: false, detail: 'health check failed' }` — never the raw exception message or stack trace, to avoid leaking internal state to the client. Neither case is ever a 500 — the first-win moment must not break on the one platform most likely to be freshly configured.
- No request body; no mutation; never calls `createListing`/`updateListing`/`markSold`/`delist`.

**UI-only static maps (no route needed, per constraint):**
- `platformTiers.ts`: `{ [platform]: 'oauth' | 'credential' }` (3 OAuth: ebay/etsy/amazon; 5 credential: poshmark/depop/mercari/vinted/grailed)
- `operabilityTiers.ts`: `{ [platform]: 'sandbox-tested' | 'live-draft-only' | 'inert-until-credentialed' | 'dry-run-until-credentialed' }`, mirroring `README.md`'s table
- `riskCopy.ts`: per-platform disclosure framing strings (ban/suspension risk language), keyed by platform rather than by trust tier alone — Poshmark cites its documented, named thresholds (`POSHMARK_RELIST_COOLDOWN_DAYS`, `POSHMARK_SHARE_CAP_PER_24H` from `lib/constants.ts`), while Depop/Mercari/Vinted/Grailed (no published policy, conservative defaults per `constants.ts`) fall back to a shared tier-level default string — matches the granularity `constants.ts` already committed to.
- `credentialFieldSpecs.ts`: per-platform `{ identifierKey, identifierLabel, secretFields: [{key, label}] }` — satisfies FR20's non-secret identifier requirement

## Integration points

- `app/connections/page.tsx` (new) — server component; reads `SESSION_COOKIE_NAME` cookie via `resolveSession` and redirects to `/login` if absent, mirroring `app/dashboard/page.tsx`; renders `<ConnectionsView />`.
- `app/connections/layout.tsx` (new) — trivial `<section>{children}</section>` wrapper, matching `app/dashboard/layout.tsx`/`app/inventory/layout.tsx` for structural parity.
- `app/api/connections/[id]/first-win/route.ts` (new) — read-only health+readiness endpoint described above; imports `resolveOwnedConnection` from `lib/apiRequest.ts`, `getConnector` from `lib/connectors/registry.ts`, and `db` from `lib/db.ts` unmodified.
- `components/connections/ConnectionsView.tsx` (new) — top-level client state machine; fetches `GET /api/connections`, owns the `flow` discriminated union (including `cardsExpanded` for the `'list'` mode), and is the single place that decides empty-state vs. cards-and-status (FR1/FR2).
- `components/connections/EmptyState.tsx` (new) — single CTA, styled like `ItemCardGrid.tsx`'s "no items yet" branch (📦-style icon + one button), satisfying FR1/FR3.
- `components/connections/ConnectCardGrid.tsx` + `ConnectCard.tsx` (new) — static 2-section render off `SUPPORTED_PLATFORMS`/`platformTiers.ts`; per-card disabled state derived from the matching `ConnectionMetadata.status` (`active`/`suspended` → disabled + routes to status row; `revoked`/none → enabled + routes to consent).
- `components/connections/StatusList.tsx` + `StatusRow.tsx` (new) — fetches `GET /api/connections/:id/consent` per existing connection to read `has_valid_consent`; 4-color badge (`green`/`yellow`/`red` off `status`; `blue` off that fetched `has_valid_consent` value, never off the enum) using the same `bg-*/dark:bg-*` badge pattern as `ItemCardGrid.tsx`'s `STATUS_STYLES`; reactivate button (suspended only) posting to `/api/connections/:id/reactivate`; reconnect link (revoked only) invoking the same `startConnectFlow(platform)` entry point as `ConnectCard`; an `active` connection with `has_valid_consent:false` routes into the credential/consent flow for that existing connection id instead of a silent dead end (see Architecture, Risk Areas).
- `components/connections/ConsentScreen.tsx` (new) — fetches `GET /api/disclosures/current` fresh per platform-attempt; renders shared `content` + `riskCopy.ts` framing; single unchecked affirm control, no pre-check (FR9/AC7).
- `components/connections/CredentialStep.tsx` (new) — renders `credentialFieldSpecs.ts` fields for the platform; on submit, performs `POST /api/connections` then `POST /api/connections/:id/consent` in sequence, using the id returned in the `POST /api/connections` response body (never a pre-existing flow-state id, including for revoked-reconnect), holding the identifier value in local state only.
- `components/connections/maskIdentifier.ts` (new) — pure function, e.g. keep first/last char, mask the rest (`h***e`); used only from client-side submitted form state, never from an API response (FR19, AC12).
- `components/connections/ConnectionConfirmation.tsx` + `FirstWinPanel.tsx` (new) — same-render masked identifier + health/readiness (FR21-24), `FirstWinPanel` fetches the new first-win route and renders a loading skeleton in the same visual language as `ItemCardGridSkeleton`.
- `components/SiteChrome.tsx` — add one `<Link href="/connections">Connections</Link>` alongside the existing Inventory/Dashboard/Playbook links; update `components/__tests__/SiteChrome.test.tsx`'s existing assertions to include it.
- `app/connections/__tests__/page.test.tsx` (new) — jsdom + Testing Library, `vi.stubGlobal('fetch', ...)` pattern (as in `app/inventory/__tests__/page.test.tsx`), driving the full state machine including network-call-order assertions for AC5/AC8/AC12.
- `components/connections/__tests__/*.test.tsx` (new) — focused unit tests per component (ConsentScreen affirm-gating, CredentialStep secret-never-logged, StatusRow color mapping, FirstWinPanel zero-count copy).
- `tests/api/connections-first-win.test.ts` (new) — API-route test for the new endpoint, using `createTestTenant()` from `tests/helpers/tenant.ts` and the existing `BOOKSELLER_DB_PATH` scratch-DB isolation, covering: healthy connector, thrown-`ConnectorNotConfiguredError` mapped to `healthy: false`, any-other-thrown-error mapped to the generic safe detail string, and tenant-scoped readiness count (a second tenant's items never counted, and non-`Unlisted` items never counted).
- `tests/e2e/connections-flow.spec.ts` (new) — Playwright happy-path: empty state → connect card → consent → credential → masked confirmation → first-win, plus the suspended-reactivate and revoked-reconnect branches, following the pattern in `tests/e2e/book-flow.spec.ts`/`helpers.ts`.

## Technology choices

None. No new library, state-management approach, or CSS system — the state machine is plain `useState` with a discriminated union (same idiom already used for `ItemFilters`/`page` in `app/inventory/page.tsx`), styling is the existing Tailwind `dark:`-paired class convention, and data fetching is plain `fetch` (as in `useAuthForm.ts`/`app/inventory/page.tsx`), not a new client library like SWR/React Query.

## Security notes

- `CredentialStep`'s error-handling path must never render, log, or expose the full submitted credential object (secret or identifier fields) in an error banner or console output — only the already-masked identifier string may ever reach the DOM or a log line. As part of implementing this, verify that the existing `POST /api/connections` and `POST /api/connections/:id/consent` endpoints' error responses never echo the submitted `credential` object back to the client (a verification check against already-shipped routes, not an expected code change to them).
- `connection.platform`, as read by the new first-win route, is already validated against `SUPPORTED_PLATFORMS` at insert time by the existing `POST /api/connections` route. The first-win route trusts this already-validated stored value and needs no additional platform validation before calling `getConnector()`.

## Risk areas

- **The new `first-win` route is the one piece of backend surface in an otherwise UI-only increment.** It must stay strictly read-only and additive (no new table, no write path) or it stops being defensible as "no data model changes" — any temptation to have it also touch `item_platforms` (e.g. to "warm" something) should be resisted; it only counts and reads.
- **`checkConnectionHealth` is not actually exception-safe for every platform** (Amazon throws `ConnectorNotConfiguredError` pre-credential) despite the interface's documented contract — the first-win route's try/catch is load-bearing; forgetting it turns "connect Amazon with no env vars configured" (the default out-of-the-box state per `README.md`) into a 500 on literally every fresh Amazon connection, defeating the "first win" moment for the platform most likely to be in that state. Any other unanticipated thrown error must fall through to the same generic safe mapping, never a raw message/stack trace to the client.
- **Consent-retry-after-stale-version is easy to get wrong.** The natural bug is to treat "create connection + record consent" as one atomic client-side action and, on a 422 from the consent call, retry the *whole* sequence — which now 409s on `POST /api/connections` (`connection_exists`, since the connection row from the first attempt is still there). The connection id from the successful create must be retained across a consent-only retry, and must always come from that create's response body — never from any id present in flow state before the create ran (this matters most in the revoked-reconnect case, where the old id is for a row that no longer exists the instant the create commits).
- **View-state ordering is the thing the acceptance tests actually check** (AC5, AC7, AC8, AC12 all hinge on exact network-call sequencing/absence). A single discriminated-union `flow` state (rather than several independent booleans like `showConsent`/`showCredential`/`cardsExpanded`) is what keeps that ordering provable instead of accidentally reachable out of sequence — worth getting right in the first implementation pass rather than patching later.
- **Masking discipline for the identifier vs. secret fields.** `CredentialStep` naturally holds both the identifier and the secret in component state to build the `credential` request body; care is needed that no shared "form state" object gets passed whole into an error banner, a console log, or a debug-only render — only the already-masked identifier string may ever reach the DOM or a log line (AC15's literal test asserts the raw secret marker never appears anywhere; see Security notes).
- **The read-path latency NFR has no numeric threshold** ("[threshold TBD]") — this plan cannot invent one, and no test can bind to it; treat it as informational/non-binding for this increment rather than something to build a perf test against.
- **The "oauth" trust-tier label (eBay/Etsy/Amazon) is a placeholder trust category, not a real OAuth implementation.** `CredentialStep` renders the identical identifier+secret form for all 8 platforms in this increment, and no authorization-code/redirect flow exists (consistent with the requirements' explicit constraint that no OAuth callback route exists). Building real OAuth for eBay/Etsy/Amazon later will require a second, structurally different `CredentialStep` variant and a callback route — not a patch to this one.
- **The masked identifier is never persisted server-side** (`ConnectionMetadata` has no identifier field) — it is a one-time-only display at the moment of connection, derived from local form state (`maskIdentifier.ts`). Revisiting `/connections` later (new session, refresh, another day) cannot show "connected as h***e" again for that connection. This is an accepted MVP limitation, not an oversight — persisting a masked (never raw) identifier would require a new non-secret column, out of scope for this UI-only increment.
- **The readiness-count query is category-agnostic by design**, counting all of a tenant's unlisted items regardless of whether a platform actually deals in that item's category (e.g. book items count toward a Grailed/Depop readiness number). This is an accepted MVP simplification — a platform→category allowlist for readiness filtering is a reasonable follow-on, not built here — and copy should avoid overclaiming precision (e.g. "N items in your inventory not yet listed here" rather than implying curated fit).
