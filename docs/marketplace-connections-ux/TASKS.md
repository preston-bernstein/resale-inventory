# Tasks: Marketplace Connections UX

Generated from: docs/marketplace-connections-ux/ on 2026-07-16

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Create static maps and constants
**Status**: [x] done
**Files**: lib/constants/platformTiers.ts, lib/constants/operabilityTiers.ts, lib/constants/riskCopy.ts, lib/constants/credentialFieldSpecs.ts
**Test**: Each map exports the correct shape (platformTiers: 8 platforms/2 tiers; credentialFieldSpecs: identifierKey/identifierLabel/secretFields per platform; riskCopy: per-platform strings falling back to tier-level default; operabilityTiers: 4 tier values per platform)
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 2: Create server page, layout, and navigation
**Status**: [x] done
**Files**: app/connections/page.tsx, app/connections/layout.tsx, components/SiteChrome.tsx, components/__tests__/SiteChrome.test.tsx
**Test**: GET /connections without session redirects to /login; with valid session renders successfully (no ConnectionsView-internals assertions); /connections link present in nav and navigates correctly
**Depends on**: none
**Parallelizable**: Yes
**Notes**:

### Task 3: Implement ConnectionsView state machine skeleton
**Status**: [x] done
**Files**: components/connections/ConnectionsView.tsx
**Test**: Renders without error; initial flow state is { mode: 'list', cardsExpanded: false }; GET /api/connections fetched on mount; state exposes connections, flow, setFlow
**Depends on**: 1, 2
**Parallelizable**: No
**Notes**:

### Task 4a: Implement empty state and connect card components
**Status**: [x] done
**Files**: components/connections/EmptyState.tsx, components/connections/ConnectCardGrid.tsx, components/connections/ConnectCard.tsx
**Test**: Empty state renders only when connections.length===0; 8 cards render in 2 tier groups; disabled iff active/suspended, enabled iff revoked/none; enabled card click sets flow to consent mode; empty-state CTA click transitions to card view with zero connections
**Depends on**: 3, 1
**Parallelizable**: Yes (once 3 is done)
**Notes**:

### Task 4b: Implement status list and status row components
**Status**: [x] done
**Files**: components/connections/StatusList.tsx, components/connections/StatusRow.tsx
**Test**: Green/yellow/red badges for active/suspended/revoked; suspended row has reactivate button (POST reactivate, 409 surfaced visibly); revoked row's reconnect link routes directly to consent screen; operability tier shown as blue informational text; active-but-unconsented (has_valid_consent false) renders distinct blue stale-consent indicator with path back into consent flow
**Depends on**: 3, 1
**Parallelizable**: Yes (once 3 is done)
**Notes**:

### Task 5: Implement ConsentScreen component
**Status**: [x] done
**Files**: components/connections/ConsentScreen.tsx
**Test**: Fetches disclosure on mount; renders version/content + per-platform riskCopy; affirm control unchecked by default; affirm transitions to credential mode with no network call; disclosure fetch error renders retry option
**Depends on**: 3, 1
**Parallelizable**: Yes (once 3 is done)
**Notes**:

### Task 6a: Implement CredentialStep form and submit sequence
**Status**: [x] done
**Files**: components/connections/CredentialStep.tsx
**Test**: Renders identifier+secret fields per platform; submit calls POST /api/connections then POST /api/connections/:id/consent using the id from the create response (never a prior flow-state connectionId, even on reconnect); secret never in logs/DOM/exposed state; success transitions to confirmed mode
**Depends on**: 3, 1, 5, 7
**Parallelizable**: No
**Notes**:

### Task 6b: Implement stale-version retry logic for CredentialStep
**Status**: [x] done
**Files**: components/connections/CredentialStep.tsx (follow-on)
**Test**: 422 stale/invalid disclosure version triggers re-fetch of GET /api/disclosures/current + retry banner; retry resubmits ONLY the consent POST against the same existing connection id, never re-POSTs /api/connections
**Depends on**: 6a
**Parallelizable**: No
**Notes**:

### Task 7: Implement masked identifier utility and ConnectionConfirmation component
**Status**: [x] done
**Files**: components/connections/maskIdentifier.ts, components/connections/ConnectionConfirmation.tsx
**Test**: maskIdentifier produces a non-degenerate mask for any length ≥1 (including 1-2 char identifiers), never the raw value; ConnectionConfirmation renders masked identifier from the maskedIdentifier prop (client-derived), never from an API response
**Depends on**: 3
**Parallelizable**: Yes (once 3 is done)
**Notes**:

### Task 8: Implement FirstWinPanel component
**Status**: [x] done
**Files**: components/connections/FirstWinPanel.tsx
**Test**: Fetches GET /api/connections/:id/first-win on mount; loading skeleton then health+readyCount render; zero-count renders health alone with non-negative copy; fetch failure shows detail string, no fallback list-all; reachable only from confirmed flow mode
**Depends on**: 3, 7, 9
**Parallelizable**: No
**Notes**:

### Task 9: Create first-win API route
**Status**: [x] done
**Files**: app/api/connections/[id]/first-win/route.ts
**Test**: 200 with { healthy, detail?, readyCount }; readyCount query filters items.status = 'Unlisted' (excludes Sold/Removed/Donated/Discarded); ConnectorNotConfiguredError maps to { healthy: false, detail: 'connector not configured' }; any other thrown error maps to a generic safe detail string, never raw exception/stack trace; never a 500; second tenant's items never counted; no write to item_platforms
**Depends on**: none (must land before Task 8 is tested)
**Parallelizable**: Yes
**Notes**:

### Task 11a: Write page integration test — happy path and network ordering
**Status**: [x] done
**Files**: app/connections/__tests__/page.test.tsx
**Test**: Empty state → cards → consent → credential → POST /api/connections → POST .../consent in exact order using create-response id → masked identifier renders (AC5/AC7/AC8/AC12); no secret in network bodies or DOM
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9, 10
**Parallelizable**: No
**Notes**:

### Task 11b: Write page integration test — post-confirmation and status updates
**Status**: [x] done
**Files**: app/connections/__tests__/page.test.tsx (continued)
**Test**: First-win fetch/render in same view, no extra navigation; revisit /connections shows new connection status; active-but-unconsented case shows stale-consent indicator with recovery path
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9, 10
**Parallelizable**: No
**Notes**:

### Task 12a: Write ConsentScreen unit test
**Status**: [x] done
**Files**: components/connections/__tests__/ConsentScreen.test.tsx
**Test**: Affirm control unchecked by default; disclosure fetched on mount
**Depends on**: 1, 5
**Parallelizable**: No
**Notes**:

### Task 12b: Write CredentialStep unit test
**Status**: [x] done
**Files**: components/connections/__tests__/CredentialStep.test.tsx
**Test**: Secret never logged; 422 retry uses same connection id without recreating; reconnect path never reuses a stale connectionId
**Depends on**: 1, 6a, 6b
**Parallelizable**: No
**Notes**:

### Task 12c: Write StatusRow unit test
**Status**: [x] done
**Files**: components/connections/__tests__/StatusRow.test.tsx
**Test**: 4-color badge mapping; reactivate call behavior; stale-consent indicator; operability tier display
**Depends on**: 1, 4b
**Parallelizable**: No
**Notes**:

### Task 12d: Write FirstWinPanel unit test
**Status**: [x] done
**Files**: components/connections/__tests__/FirstWinPanel.test.tsx
**Test**: Zero-count copy differs from error framing; health status displays correctly
**Depends on**: 1, 8
**Parallelizable**: No
**Notes**:

### Task 13: Write API route test
**Status**: [x] done
**Files**: tests/api/connections-first-win.test.ts
**Test**: Healthy connector returns readyCount>0 excluding non-Unlisted items; thrown ConnectorNotConfiguredError → healthy:false not 500; second tenant's items never counted; 404 on missing/cross-tenant; read-only (no writes to item_platforms)
**Depends on**: 9
**Parallelizable**: No
**Notes**:

### Task 14a: Write E2E test — happy path
**Status**: [x] done
**Files**: tests/e2e/connections-flow.spec.ts
**Test**: Full happy path completes; no secrets in DOM; masked identifier matches input; health/readiness render correctly
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9, 10
**Parallelizable**: No
**Notes**:

### Task 14b: Write E2E test — suspended-reactivate branch
**Status**: [x] done
**Files**: tests/e2e/connections-flow.spec.ts (continued)
**Test**: Status view → reactivate → status becomes active
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9, 10
**Parallelizable**: No
**Notes**:

### Task 14c: Write E2E test — revoked-reconnect branch
**Status**: [x] done
**Files**: tests/e2e/connections-flow.spec.ts (continued)
**Test**: Status view → reconnect → new connection with NEW id → consent POST uses new id, not any prior one
**Depends on**: 2, 3, 4a, 4b, 5, 6a, 6b, 7, 8, 9, 10
**Parallelizable**: No
**Notes**:

### Task 10: Wire real sub-components into ConnectionsView
**Status**: [x] done
**Files**: components/connections/ConnectionsView.tsx
**Test**: Full flow renders real components (not placeholders) per flow.mode: EmptyState/ConnectCardGrid+StatusList for 'list', ConsentScreen for 'consent', CredentialStep for 'credential', ConnectionConfirmation+FirstWinPanel for 'confirmed'; reactivate/reconnect/resume-consent callbacks trigger correct flow transitions and connection-list refetches
**Depends on**: 3, 4a, 4b, 5, 6a, 6b, 7, 8
**Parallelizable**: No
**Notes**: Added during implementation — steps.md never had an explicit step to wire the standalone sub-components (built self-contained per-task to avoid file-conflict races) into ConnectionsView.tsx, which Task 3 deliberately left rendering placeholder divs. Closed that gap before the test rounds. Also resolves the disclosureVersion threading: ConsentScreen's onAffirm(version) is captured in ConnectionsView's own local state (not added to the Flow union type) and passed to CredentialStep as a prop. KNOWN LIMITATION flagged by this task: `onResumeConsent` (active-but-unconsented recovery) routes through the same fresh-consent path as reconnect, which will hit `POST /api/connections`'s 409 `connection_exists` since the connection's status is `active`, not `revoked` — fixing this needs a new "resume consent without recreating" API path, out of scope for this increment. Carry into Phase 10 ship-it report as a follow-on item, and 11b/14-series tests should not assert this sub-path works end-to-end (only that the callback routes to the consent screen, not that the whole resume succeeds).

## Blocked / open
(populated during implementation)
