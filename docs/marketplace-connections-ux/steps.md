# Steps: Marketplace Connections UX

## Prerequisites

None. This increment consumes seven existing API routes unchanged (`GET /api/connections`, `GET /api/connections/:id`, `GET/POST /api/connections/:id/consent`, `GET /api/disclosures/current`, `POST /api/connections` (create), `POST /api/connections/:id/reactivate`), requires only the new `/api/connections/:id/first-win` read-only route plus client-side components and static data maps. Note: `PATCH /api/connections/:id/credential` exists in the API surface but is not used by this feature; reconnect goes through `POST /api/connections`'s delete-then-recreate path instead.

## Implementation steps

### Step 1: Create static maps and constants
**What**: Define `platformTiers`, `operabilityTiers`, `riskCopy`, and `credentialFieldSpecs` as client-side lookup tables.
**Files**: `lib/constants/platformTiers.ts`, `lib/constants/operabilityTiers.ts`, `lib/constants/riskCopy.ts`, `lib/constants/credentialFieldSpecs.ts`
**Test**: Verify each map exports the correct shape (platformTiers has 8 platforms in 2 tiers; credentialFieldSpecs has `identifierKey`, `identifierLabel`, `secretFields` per platform; riskCopy has OAuth and credential tier strings; operabilityTiers has sandbox-tested/live-draft-only/inert-until-credentialed/dry-run-until-credentialed values per platform).
**Depends on**: none
**Parallelizable**: Yes

### Step 2: Create server page, layout, and navigation
**What**: Scaffold `app/connections/page.tsx` (server component with session check, redirects to /login if absent), `app/connections/layout.tsx` (trivial section wrapper), and add a `/connections` link to `components/SiteChrome.tsx` global nav.
**Files**: `app/connections/page.tsx`, `app/connections/layout.tsx`, `components/SiteChrome.tsx`, `components/__tests__/SiteChrome.test.tsx`
**Test**: `GET /connections` without a session cookie redirects to `/login`; with a valid session, renders successfully (no assertions on `<ConnectionsView />` internals — that is tested in Step 3); verify `/connections` link is present in SiteChrome nav; verify clicking the link navigates to `/connections`.
**Depends on**: none
**Parallelizable**: Yes

### Step 3: Implement ConnectionsView state machine skeleton
**What**: Build the top-level client state component that owns the discriminated-union `flow` state (list | consent | credential | confirmed) and fetches `GET /api/connections` on mount.
**Files**: `components/connections/ConnectionsView.tsx`
**Test**: Verify component renders without error; initial state is `flow: { mode: 'list' }`; `GET /api/connections` fetch is called on mount; state shape includes `connections`, `flow`, `setFlow`, `currentFlow` derived state.
**Depends on**: 1, 2
**Parallelizable**: No

### Step 4a: Implement empty state and connect card components
**What**: Build EmptyState, ConnectCardGrid/ConnectCard (8 cards split by tier, card disabled if connection status is active/suspended).
**Files**: `components/connections/EmptyState.tsx`, `components/connections/ConnectCardGrid.tsx`, `components/connections/ConnectCard.tsx`
**Test**: Verify empty state renders only when `connections.length === 0`; connect cards render 3 OAuth and 5 credential-tier groups; card action is disabled/enabled per connection status (`active`/`suspended` → disabled, `revoked`/none → enabled); clicking a card with no connection or revoked status calls `setFlow({ mode: 'consent', platform })`; clicking empty-state CTA transitions to connect-card view while still zero connections exist (covers requirement 3).
**Depends on**: 3, 1
**Parallelizable**: Yes (once step 3 is done)

### Step 4b: Implement status list and status row components
**What**: Build StatusList/StatusRow (4-color severity badge off `status`, reactivate button for suspended, reconnect link for revoked, plus fetch `GET /api/connections/:id/consent` per connection to render distinct stale-consent blue indicator when `status` is `active` but `has_valid_consent` is false).
**Files**: `components/connections/StatusList.tsx`, `components/connections/StatusRow.tsx`
**Test**: Verify status rows render green/yellow/red badges for active/suspended/revoked per status field; suspended row has reactivate button (calls `POST /api/connections/:id/reactivate` and refreshes status on success, surfaces 409 error visibly); revoked row has reconnect link that routes to that platform's consent screen directly (not the connect card); operability tier renders as informational text distinct from connection_status color; active-but-unconsented case (status `active` but `has_valid_consent` false) renders distinct blue stale-consent indicator with a way back into consent flow for that connection.
**Depends on**: 3, 1
**Parallelizable**: Yes (once step 3 is done)

### Step 5: Implement ConsentScreen component
**What**: Build the disclosure/consent screen that fetches `GET /api/disclosures/current`, renders shared content + tier-specific risk copy, and presents a single unchecked affirm control.
**Files**: `components/connections/ConsentScreen.tsx`
**Test**: Verify component fetches disclosure on mount; renders the disclosure version and content; renders platform-specific risk copy from `riskCopy.ts` (OAuth vs. credential tier); affirm control is unchecked (not pre-checked); clicking affirm calls `setFlow({ mode: 'credential', platform })` without making any POST call; if disclosure fetch returns 404 or errors, error state renders with retry option.
**Depends on**: 3, 1
**Parallelizable**: Yes (once step 3 is done)

### Step 6a: Implement CredentialStep form and submit sequence
**What**: Build the credential input form that renders platform-specific fields from `credentialFieldSpecs.ts` (identifier + secret fields), captures the identifier in a local variable on form state (never logs or exposes the secret), and on submit executes the sequence: `POST /api/connections { platform, credential }` → `POST /api/connections/:id/consent { disclosure_version }` using the `id` returned in the `POST /api/connections` response body (critical: must use newly-returned id, never a `connectionId` carried in prior flow state, even on the revoked-reconnect path) → `setFlow({ mode: 'confirmed', platform, connectionId, maskedIdentifier })`.
**Files**: `components/connections/CredentialStep.tsx`
**Test**: Verify form renders identifier and secret input fields per platform; on submit, network calls happen in order (create connection first using its response id, then consent); if consent succeeds (201), advance to confirmed mode; verify the secret field value never appears in console logs, error messages, or form state exposed outside the component scope; verify only the identifier field (masked) is carried to the next step.
**Depends on**: 3, 1, 5, 7
**Parallelizable**: No

### Step 6b: Implement stale-version retry logic for CredentialStep
**What**: Add 422 stale/invalid disclosure-version handling to CredentialStep: when consent POST returns 422, re-fetch `GET /api/disclosures/current`, render retry banner, and retry ONLY the consent POST against the same existing connection id (never re-POST `/api/connections`, which would now 409).
**Files**: `components/connections/CredentialStep.tsx` (follow-on change)
**Test**: Verify consent POST returning 422 stale/invalid version triggers disclosure re-fetch + retry banner; retry re-submits only the consent call with the same connection id, never recreates the connection.
**Depends on**: 6a
**Parallelizable**: No

### Step 7: Implement masked identifier utility and ConnectionConfirmation component
**What**: Create `maskIdentifier.ts` (pure function that masks all but first/last chars, e.g. `h***e`); build ConnectionConfirmation that renders the masked identifier string derived from the submitted form state (not from any API response).
**Files**: `components/connections/maskIdentifier.ts`, `components/connections/ConnectionConfirmation.tsx`
**Test**: Verify `maskIdentifier('hello')` returns `h***o` (exact masking pattern TBD per project convention, but must not expose raw value); verify ConnectionConfirmation renders masked identifier immediately on confirmed flow state; verify the masked string is sourced from the `maskedIdentifier` prop (derived client-side before confirmed state), not from any API response body.
**Depends on**: 3
**Parallelizable**: Yes (once step 3 is done)

### Step 8: Implement FirstWinPanel component
**What**: Build the first-win display component that fetches `GET /api/connections/:id/first-win` on mount, renders health-check result (healthy boolean + detail string) and readiness count (tenant's items not yet listed on this platform), with zero-count copy different from failure framing.
**Files**: `components/connections/FirstWinPanel.tsx`
**Test**: Verify component fetches endpoint on mount; renders skeleton while loading; on success, displays health status (green checkmark if healthy, red X if not) and readiness count (e.g. "5 items ready to list"); if count is 0, renders health alone with copy like "No items to list yet"; if fetch fails (e.g. connector not configured), displays `detail` string and does not attempt fallback list-all behavior; reachable only from ConnectionConfirmation (confirmed flow mode).
**Depends on**: 3, 7, 9
**Parallelizable**: No

### Step 9: Create first-win API route
**What**: Implement `app/api/connections/[id]/first-win/route.ts` (GET, read-only) that resolves the connection via `resolveOwnedConnection` (tenant-scoped), calls `getConnector(connection.platform).checkConnectionHealth(tenantId, id)` wrapped in try/catch (mapping `ConnectorNotConfiguredError` to `{ healthy: false, detail: 'connector not configured' }`), and returns `{ healthy: boolean, detail?: string, readyCount: number }` where readyCount is a single `SELECT COUNT(*)` query scoped to the tenant's items not yet in `item_platforms` for that platform.
**Files**: `app/api/connections/[id]/first-win/route.ts`
**Test**: Verify endpoint returns 200 with correct shape; test with a healthy connector (readyCount > 0); test with a connector that throws (Amazon without env creds) and verify it returns `healthy: false, detail: 'connector not configured'` not a 500; test tenant-scoping by verifying a second tenant's items are never counted in readyCount; verify no `PATCH` or write operation touches `item_platforms`.
**Depends on**: none (can be implemented in parallel but must be done before step 8 is tested)
**Parallelizable**: Yes

### Step 11a: Write page integration test — happy path and network ordering
**What**: Implement `app/connections/__tests__/page.test.tsx` (jsdom + Testing Library) driving the happy-path flow: fetch `GET /api/connections` (empty), verify empty state renders; click empty-state CTA, verify connect cards render; click a card, verify `GET /api/disclosures/current` is called and disclosure renders; affirm consent, verify credential fields render; submit credentials, verify `POST /api/connections` → `POST /api/connections/:id/consent` are called in exact order using the create response's id (AC5/AC8); verify masked identifier appears after success.
**Files**: `app/connections/__tests__/page.test.tsx`
**Test**: Run `npm test app/connections/__tests__/page.test.tsx`; all network-call-ordering assertions pass; state transitions match AC5/AC7/AC8/AC12; no credential secret value appears in network bodies or rendered DOM.
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9
**Parallelizable**: No

### Step 11b: Write page integration test — post-confirmation and status updates
**What**: Extend `app/connections/__tests__/page.test.tsx` to verify: post-confirmation first-win render (verify `GET /api/connections/:id/first-win` is called in the same view with no extra navigation), health status and readiness count render correctly; revisit `/connections` and verify connection status list displays the new active connection; verify active-but-unconsented recovery case (active status but stale consent) renders the distinct stale-consent indicator and provides a way back into consent flow.
**Files**: `app/connections/__tests__/page.test.tsx` (continued)
**Test**: Run `npm test app/connections/__tests__/page.test.tsx`; all assertions pass; first-win fetch and display verified; revisited status list includes new connection with correct status.
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9
**Parallelizable**: No

### Step 12a: Write ConsentScreen unit test
**What**: Implement `components/connections/__tests__/ConsentScreen.test.tsx` verifying affirm control is unchecked by default and disclosure fetch is called on mount.
**Files**: `components/connections/__tests__/ConsentScreen.test.tsx`
**Test**: Run `npm test components/connections/__tests__/ConsentScreen.test.tsx`; all assertions pass.
**Depends on**: 1, 5
**Parallelizable**: No

### Step 12b: Write CredentialStep unit test
**What**: Implement `components/connections/__tests__/CredentialStep.test.tsx` verifying secret never logged, consent retry on stale version (422) uses same connection id without recreating, and never reuses a stale connectionId on reconnect path.
**Files**: `components/connections/__tests__/CredentialStep.test.tsx`
**Test**: Run `npm test components/connections/__tests__/CredentialStep.test.tsx`; all assertions pass; verify no credential secrets in error states or logs.
**Depends on**: 1, 6a, 6b
**Parallelizable**: No

### Step 12c: Write StatusRow unit test
**What**: Implement `components/connections/__tests__/StatusRow.test.tsx` verifying 4-color badge mapping (green/yellow/red per status), reactivate call behavior, stale-consent indicator rendering, and operability tier display.
**Files**: `components/connections/__tests__/StatusRow.test.tsx`
**Test**: Run `npm test components/connections/__tests__/StatusRow.test.tsx`; all assertions pass.
**Depends on**: 1, 4b
**Parallelizable**: No

### Step 12d: Write FirstWinPanel unit test
**What**: Implement `components/connections/__tests__/FirstWinPanel.test.tsx` verifying zero-count copy differs from error framing and health status displays correctly.
**Files**: `components/connections/__tests__/FirstWinPanel.test.tsx`
**Test**: Run `npm test components/connections/__tests__/FirstWinPanel.test.tsx`; all assertions pass.
**Depends on**: 1, 8
**Parallelizable**: No

### Step 13: Write API route test
**What**: Implement `tests/api/connections-first-win.test.ts` (using `createTestTenant()` and `BOOKSELLER_DB_PATH` scratch-DB isolation) covering: healthy connection returns `{ healthy: true, readyCount: N }`; connector throws `ConnectorNotConfiguredError` returns `{ healthy: false, detail: 'connector not configured' }`, not a 500; second tenant's items never counted; 404 on missing/cross-tenant connection.
**Files**: `tests/api/connections-first-win.test.ts`
**Test**: Run `npm test tests/api/connections-first-win.test.ts`; all assertions pass; endpoint is read-only, never writes to `item_platforms`.
**Depends on**: 9
**Parallelizable**: No

### Step 14a: Write E2E test — happy path
**What**: Implement `tests/e2e/connections-flow.spec.ts` (Playwright) covering happy-path flow: empty state → connect card → consent → credential → masked confirmation → first-win with health/readiness.
**Files**: `tests/e2e/connections-flow.spec.ts`
**Test**: Run `npm run test:e2e tests/e2e/connections-flow.spec.ts`; happy path flow completes without error; page never shows credential secrets in DOM; masked identifier matches form input; health checkmark/X renders; item readiness count is correct.
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9
**Parallelizable**: No

### Step 14b: Write E2E test — suspended-reactivate branch
**What**: Extend `tests/e2e/connections-flow.spec.ts` to cover suspended-reactivate branch: status view → reactivate button click → connection status becomes active.
**Files**: `tests/e2e/connections-flow.spec.ts` (continued)
**Test**: Run `npm run test:e2e tests/e2e/connections-flow.spec.ts`; reactivate branch flow completes without error.
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9
**Parallelizable**: No

### Step 14c: Write E2E test — revoked-reconnect branch
**What**: Extend `tests/e2e/connections-flow.spec.ts` to cover revoked-reconnect branch: status view → reconnect link → consent flow again → new connection created with NEW id (asserting consent POST uses new id, not any prior).
**Files**: `tests/e2e/connections-flow.spec.ts` (continued)
**Test**: Run `npm run test:e2e tests/e2e/connections-flow.spec.ts`; revoked-reconnect branch flow completes without error; new connection id is used for consent POST.
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9
**Parallelizable**: No

## Rollback plan

Steps 1–3, 5, 7, 9 (foundation, components, static maps, routes) are all safe reversals via `git checkout` or `git reset`. No migrations, no data model changes, no cross-repo dependencies.

Steps 4a, 4b, 8 are safe reversals; no data model changes.

**Special scrutiny**: Steps 6a/6b (client-side credential and secret handling) are the highest-risk steps in this increment per the spec's own risk framing around credential exposure. These steps should receive extra code review before merge, not just a plain revert on rollback. Review focus: secret field never persisted outside component scope, identifier masking applied before confirmed state, no raw credential in logs/DOM/error messages.

**Paired rollback**: Steps 8 (FirstWinPanel) and 9 (first-win API route) must revert together — reverting Step 9 alone while Step 8 is live breaks FirstWinPanel with unhandled fetch failures.

Steps 11a–11b, 12a–12d, 13, 14a–14c (tests) are test-only changes; rolling back is a `git reset` of test files.

**Summary**: All steps reversible via git; no risky destructive operations, no database changes, no credential exposure at rollback time (after extra review of 6a/6b per above).

