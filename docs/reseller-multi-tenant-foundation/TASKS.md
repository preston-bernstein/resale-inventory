# Tasks: Multi-Tenant Foundation for Reseller/Cross-Listing Integration

Generated from: docs/reseller-multi-tenant-foundation/ on 2026-07-15

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1a: Create tenants migration, register it, and add constants
**Status**: [x] done
**Files**: data/migrations/005_tenants.sql, lib/db.ts, lib/constants.ts
**Test**: PRAGMA user_version reaches 5; tenants/tenant_sessions tables exist; DEFAULT_TENANT_ID equals seeded row id
**Depends on**: none
**Parallelizable**: No
**Notes**:

### Task 1b: Create tenant_scoping migration
**Status**: [x] done
**Files**: data/migrations/006_tenant_scoping.sql, lib/db.ts
**Test**: PRAGMA user_version reaches 6; all six tables have tenant_id; consistency trigger rejects mismatched tenant_id
**Depends on**: 1a
**Parallelizable**: No
**Notes**:

### Task 1c: Create platform_connections migration
**Status**: [x] done
**Files**: data/migrations/007_platform_connections.sql, lib/db.ts
**Test**: PRAGMA user_version reaches 7; platform_connections (status col) + connection_status_events exist
**Depends on**: 1a
**Parallelizable**: No
**Notes**:

### Task 1d: Create consent_capture migration
**Status**: [x] done
**Files**: data/migrations/008_consent_capture.sql, lib/db.ts
**Test**: PRAGMA user_version reaches 8; disclosure_versions seeded; tenant_consents exists
**Depends on**: 1a
**Parallelizable**: No
**Notes**:

### Task 2: Implement lib/tenantAuth.ts
**Status**: [x] done
**Files**: lib/tenantAuth.ts
**Test**: unit tests for password hash, session token issuance/validation, timingSafeEqual usage
**Depends on**: 1a
**Parallelizable**: Yes
**Notes**:

### Task 3: Create test helpers and createTestTenant fixture
**Status**: [x] done
**Files**: tests/helpers/tenant.ts, tests/setup.ts
**Test**: createTestTenant() inserts tenant + resolves session; unique emails per call
**Depends on**: 1a, 2
**Parallelizable**: No
**Notes**:

### Task 4: Implement lib/credentialCrypto.ts
**Status**: [x] done
**Files**: lib/credentialCrypto.ts, vitest.config.ts, playwright.config.ts
**Test**: encrypt/decrypt round-trip; scratch key-path env var isolates tests from real data/credential.key
**Depends on**: 1a
**Parallelizable**: Yes
**Notes**:

### Task 5: Enhance lib/apiRequest.ts with requireTenant
**Status**: [x] done
**Files**: lib/apiRequest.ts
**Test**: valid cookie -> {tenantId}; missing/expired/revoked -> 401
**Depends on**: 2
**Parallelizable**: No
**Notes**:

### Task 6: Implement lib/connections.ts (CRUD)
**Status**: [x] done
**Files**: lib/connections.ts
**Test**: cross-tenant reads empty; create round-trips via encrypt/decrypt; list scoped to tenant
**Depends on**: 1c, 4
**Parallelizable**: Yes
**Notes**:

### Task 7: Kill-switch functions in lib/connections.ts
**Status**: [x] done
**Files**: lib/connections.ts
**Test**: recordSuspensionSignal atomic; reactivate rejects revoked; reactivate-on-active errors
**Depends on**: 6
**Parallelizable**: No
**Notes**:

### Task 8: Implement lib/consent.ts
**Status**: [x] done
**Files**: lib/consent.ts
**Test**: per-tenant-per-platform scoping; version-bump invalidates; revoke invalidates immediately
**Depends on**: 1d
**Parallelizable**: Yes
**Notes**:

### Task 9: Implement lib/automationGate.ts
**Status**: [x] done
**Files**: lib/automationGate.ts
**Test**: suspended/revoked blocks; missing/revoked consent blocks; active+consented allows
**Depends on**: 7, 8
**Parallelizable**: No
**Notes**:

### Task 10: Auth routes (signup, login, logout)
**Status**: [x] done
**Files**: app/api/auth/signup/route.ts, app/api/auth/login/route.ts, app/api/auth/logout/route.ts
**Test**: signup/login/logout E2E; cookie httpOnly asserted
**Depends on**: 2
**Parallelizable**: Yes
**Notes**:

### Task 11: Login/signup pages
**Status**: [x] done
**Files**: app/login/page.tsx, app/signup/page.tsx
**Test**: form submit creates tenant / sets session cookie; invalid creds show error, no cookie
**Depends on**: 10
**Parallelizable**: Yes
**Notes**:

### Task 12: Connection routes (list/create/get)
**Status**: [x] done
**Files**: app/api/connections/route.ts, app/api/connections/[id]/route.ts
**Test**: cross-tenant 404; revoked-connection reconnect succeeds; active/suspended blocks with 409
**Depends on**: 5, 6
**Parallelizable**: Yes
**Notes**:

### Task 13: Credential-rotation and reactivate routes
**Status**: [x] done
**Files**: app/api/connections/[id]/credential/route.ts, app/api/connections/[id]/reactivate/route.ts
**Test**: rotate re-encrypts; recordSuspensionSignal() + reactivate -> active; reactivate revoked -> 409
**Depends on**: 12, 7
**Parallelizable**: Yes
**Notes**:

### Task 14: Consent and disclosure routes
**Status**: [x] done
**Files**: app/api/connections/[id]/consent/route.ts, app/api/disclosures/current/route.ts
**Test**: consent required before automation; revoke blocks; stale version errors; disclosure route works with no cookie
**Depends on**: 8 (+5 for tenant-scoped routes only)
**Parallelizable**: Yes
**Notes**:

### Task 15: Retrofit /api/items core routes
**Status**: [x] done
**Files**: app/api/items/route.ts, app/api/items/[id]/route.ts
**Test**: unauthenticated 401; cross-tenant mutate 404
**Depends on**: 1b, 5, 3
**Parallelizable**: Yes
**Notes**:

### Task 16: Phone-handoff auth carve-out
**Status**: [x] done
**Files**: app/api/phone-session/[token]/route.ts, app/api/items/[id]/photos/route.ts, lib/pairingToken.ts
**Test**: X-Pairing-Token path works with no session cookie; pairing token scoped to its own tenant/item only
**Depends on**: 1b, 5
**Parallelizable**: Yes
**Notes**:

### Task 17: Retrofit /api/items status and photos routes
**Status**: [x] done
**Notes**: tests/api/items-status.test.ts left broken (not in file list) — Task 22 must retrofit it alongside items.test.ts/items-id.test.ts from Task 15.
**Files**: app/api/items/[id]/status/route.ts, app/api/items/[id]/photos/route.ts, app/api/items/[id]/photos/[photoId]/route.ts, app/api/items/[id]/phone-session/route.ts
**Test**: unauthenticated 401; cross-tenant 404; X-Pairing-Token path from Task 16 unaffected
**Depends on**: 15, 16, 5, 3
**Parallelizable**: Yes
**Notes**:

### Task 18: Set tenant_id on price_history writes
**Status**: [x] done
**Notes**: verified no-op — Task 15's fix in app/api/items/[id]/route.ts already covers the only INSERT INTO price_history call site.
**Files**: lib/transitions.ts, app/api/items/[id]/status/route.ts
**Test**: status change produces price_history row with tenant_id matching item
**Depends on**: 17, 1b
**Parallelizable**: No
**Notes**:

### Task 19: Update lib/dashboard.ts + retrofit /api/dashboard
**Status**: [x] done
**Notes**: PRODUCTION BREAK fixed by orchestrator directly: app/dashboard/page.tsx now resolves the session server-side via next/headers cookies() + lib/tenantAuth.ts's resolveSession(), redirects to /login if no valid session, passes tenantId to getDashboardData(). Also restored node_modules (was empty in this worktree, unrelated env issue) via npm install — fixed a spurious qrcode/PhoneHandoff.tsx typecheck error as a side effect. Remaining known test debt for Task 22: lib/__tests__/dashboard.test.ts, tests/api/dashboard.test.ts, tests/api/export.test.ts (also broken, not previously flagged by Task 20).
**Files**: lib/dashboard.ts, app/api/dashboard/route.ts
**Test**: dashboard scoped per tenant; unauthenticated 401; zero cross-tenant overlap
**Depends on**: 5, 1b
**Parallelizable**: Yes
**Notes**:

### Task 20: Retrofit /api/export
**Status**: [x] done
**Files**: app/api/export/route.ts
**Test**: export scoped to tenant; unauthenticated 401
**Depends on**: 5, 1b
**Parallelizable**: Yes
**Notes**:

### Task 21: Retrofit /api/import, /api/isbn, /api/suggestions
**Status**: [x] done
**Notes**: DONE — see below
**Notes**: tests/api/import.test.ts, tests/api/suggestions.test.ts (not in file list) left broken — every request now hits requireTenant() with no session cookie, so assertions expecting the old unauthenticated behavior now see 401. tests/api/isbn.test.ts required a mechanical fix (request objects changed from `new Request(...)` to `new NextRequest(...)` since the route's GET signature had to change from `Request` to `NextRequest` for `.cookies` access) to keep typechecking, but is likewise left with 401-vs-expected-status runtime failures. Task 22 must retrofit all three alongside items.test.ts/items-id.test.ts/items-status.test.ts from Tasks 15/17. Confirmed all three suggestions.test.ts SQL blocks (size_label, CLOTHING_FIELDS, BOOK_FIELDS) got independent `tenant_id = ?` scoping, and import's item + book_details/clothing_details satellite inserts all carry tenant_id (isbn dedupe pre-check intentionally left globally-scoped, matching app/api/items/route.ts's checkDuplicateIsbn — see plan.md's documented deferred cross-tenant ISBN-uniqueness gap). New throwaway coverage: tests/api/import-isbn-suggestions-tenant-scoping.test.ts (5 tests, passing).
**Files**: app/api/import/route.ts, app/api/isbn/[isbn]/route.ts, app/api/items/suggestions/route.ts
**Test**: unauthenticated 401; imported items land on authenticated tenant
**Depends on**: 5, 1b, 3
**Parallelizable**: Yes
**Notes**:

### Task 22: Acceptance tests for AC1-15
**Status**: [x] done
**Files**: tests/api/auth.test.ts, tests/api/connections.test.ts, tests/api/consent.test.ts, tests/api/tenant-isolation.test.ts, tests/api/kill-switch.test.ts, plus retrofit of tests/api/items.test.ts, items-id.test.ts, items-status.test.ts, import.test.ts, suggestions.test.ts, isbn.test.ts, export.test.ts, dashboard.test.ts, lib/__tests__/dashboard.test.ts
**Test**: npm test && npm run test:e2e all pass
**Depends on**: 1a-21 (all preceding tasks)
**Parallelizable**: No
**Notes**: Agent's own final report was truncated (never wrote "Task 22 complete" or updated this file), so orchestrator verified directly: `npx tsc --noEmit` clean; `npm test` — 57 test files, 959 passed, 18 skipped, 0 failed; `npm run lint` — 0 errors, 35 pre-existing-style warnings (non-null assertions in test files, consistent with existing codebase convention, CI doesn't fail on warnings). `npm run test:e2e` — 31/31 passed (1.3m), including a new tests/e2e/auth.setup.ts that authenticates a single E2E tenant for the whole suite. All builds/tests fully green.

## Blocked / open
(populated during implementation)
