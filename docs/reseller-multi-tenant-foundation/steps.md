# Steps: Multi-Tenant Foundation for Reseller/Cross-Listing Integration

## Prerequisites

- Node 18+, `npm` installed, `better-sqlite3` and existing dev environment working
- No external services required; all crypto uses Node built-in modules
- Pre-existing inventory data will migrate to a default tenant during step 1a

## Implementation steps

### Step 1a: Create tenants migration, register it, and add constants
**What**: Create `data/migrations/005_tenants.sql` — `tenants` and `tenant_sessions` tables, plus the seeded default-tenant row (`00000000-0000-4000-8000-000000000000`). Register it as version 5 in `lib/db.ts`'s `VERSIONED_MIGRATIONS` array. Add `DEFAULT_TENANT_ID` (must match the migration-seeded UUID above), `SESSION_COOKIE_NAME`, `SUPPORTED_PLATFORMS` (app-layer allowlist), and `DISCLOSURE_VERSION_CURRENT` to `lib/constants.ts`.
**Files**: data/migrations/005_tenants.sql, lib/db.ts, lib/constants.ts
**Test**: Run `npm test` against a fresh scratch DB (`BOOKSELLER_DB_PATH` set to a temp file); confirm `PRAGMA user_version` reaches 5 and `tenants`/`tenant_sessions` tables exist via `sqlite3 $BOOKSELLER_DB_PATH ".tables"`; verify `lib/constants.ts`'s exports import without error and `DEFAULT_TENANT_ID` equals the seeded row's `id`.
**Depends on**: none
**Parallelizable**: No

### Step 1b: Create tenant_scoping migration
**What**: Create `data/migrations/006_tenant_scoping.sql` — six `ALTER TABLE ... ADD COLUMN tenant_id` statements (items, book_details, clothing_details, item_platforms, item_photos, price_history), each defaulting to the default tenant, plus a trigger that enforces tenant_id consistency between each satellite row and its parent item (rejects an insert/update whose satellite tenant_id doesn't match the parent `items.tenant_id`). Register it as version 6 in `lib/db.ts`'s `VERSIONED_MIGRATIONS` array.
**Files**: data/migrations/006_tenant_scoping.sql, lib/db.ts
**Test**: Confirm `PRAGMA user_version` reaches 6; confirm all six tables have a `tenant_id` column via `sqlite3 $BOOKSELLER_DB_PATH ".schema items"` (and the other five tables); insert/update a satellite row with a tenant_id that doesn't match its parent item's tenant_id and confirm the trigger rejects it.
**Depends on**: 1a
**Parallelizable**: No

### Step 1c: Create platform_connections migration
**What**: Create `data/migrations/007_platform_connections.sql` — `platform_connections` table (a `status` column — renamed from the earlier `connection_status` naming — `CHECK`'d to `active`/`suspended`/`revoked`, `UNIQUE(tenant_id, platform)`, `encrypted_credential` BLOB) and the `connection_status_events` audit table, with supporting indexes and constraints. Register it as version 7 in `lib/db.ts`'s `VERSIONED_MIGRATIONS` array.
**Files**: data/migrations/007_platform_connections.sql, lib/db.ts
**Test**: Confirm `PRAGMA user_version` reaches 7; confirm `platform_connections` and `connection_status_events` tables exist and `platform_connections` has a `status` column (not `connection_status`).
**Depends on**: 1a
**Parallelizable**: No

### Step 1d: Create consent_capture migration
**What**: Create `data/migrations/008_consent_capture.sql` — `disclosure_versions` table (seeded with version 1 content) and `tenant_consents` table. Register it as version 8 in `lib/db.ts`'s `VERSIONED_MIGRATIONS` array.
**Files**: data/migrations/008_consent_capture.sql, lib/db.ts
**Test**: Confirm `PRAGMA user_version` reaches 8; confirm `disclosure_versions` has exactly one seeded row and `tenant_consents` table exists.
**Depends on**: 1a
**Parallelizable**: No

### Step 2: Implement lib/tenantAuth.ts
**What**: Implement tenant signup, login, session-token issuance/validation using scrypt password hashing and sha256-hashed session cookies following the lib/pairingToken.ts pattern.
**Files**: lib/tenantAuth.ts
**Test**: Unit tests for password hash, session token generation, session validation; verify timingSafeEqual is used for auth checks to prevent timing attacks.
**Depends on**: 1a
**Parallelizable**: Yes

### Step 3: Create test helpers and createTestTenant fixture
**What**: Implement `tests/helpers/tenant.ts` with `createTestTenant()` (insert a tenant row and return a valid session cookie, using lib/tenantAuth.ts's session-issuance logic directly), and update `tests/setup.ts` to make it available to test suites. `createTestTenant()` must generate a unique email per call (e.g. a uuid-based local part such as `test-${randomUUID()}@example.invalid`) to prevent cross-test-file email collisions, since `tenants.email` is UNIQUE and the test suite shares one scratch DB with `fileParallelism: false`. Every existing and future API test must call `createTestTenant()` before making requests once `requireTenant()` lands on their routes (Steps 5, 10, 12–21).
**Files**: tests/helpers/tenant.ts, tests/setup.ts
**Test**: Verify `createTestTenant()` inserts a tenant row and returns a cookie whose token resolves to that tenant via lib/tenantAuth.ts's session-resolution function; verify repeated calls within a run produce distinct emails and no UNIQUE constraint violation. (Full requireTenant()-based, route-level cross-tenant isolation is exercised later once Step 5 and the route-retrofit steps land.)
**Depends on**: 1a, 2
**Parallelizable**: No

### Step 4: Implement lib/credentialCrypto.ts
**What**: Implement AES-256-GCM encrypt/decrypt for marketplace credentials, loading the master key from `BOOKSELLER_CREDENTIAL_KEY` env var or a `data/credential.key` fallback file (0600, gitignored). Add a scratch-path environment-variable override for the fallback key file (mirroring the existing `BOOKSELLER_DB_PATH` pattern, e.g. `BOOKSELLER_CREDENTIAL_KEY_PATH`), and set it in `vitest.config.ts`'s and `playwright.config.ts`'s `test.env` blocks so test runs never touch the real repo-tree key file.

**Rollback note**: This increment has no key-rotation or recovery path. Losing `BOOKSELLER_CREDENTIAL_KEY` / `data/credential.key` before any real tenant credentials are stored is safe — just regenerate it. Once real credentials exist in `platform_connections.encrypted_credential`, losing the key is unrecoverable; this is a documented operational constraint, not something this increment builds a fix for.
**Files**: lib/credentialCrypto.ts, vitest.config.ts, playwright.config.ts
**Test**: Unit tests encrypting/decrypting sample credentials; verify ciphertext is not equal to plaintext, and decrypt recovers the original; verify a test run with the scratch env var set reads/writes the key file only at the scratch path, never at `data/credential.key`.
**Depends on**: 1a
**Parallelizable**: Yes

### Step 5: Enhance lib/apiRequest.ts with requireTenant middleware
**What**: Add requireTenant(request) function that resolves the session cookie to a tenant_id, returning 401 Unauthorized if no valid session exists.
**Files**: lib/apiRequest.ts
**Test**: Unit test with valid session cookie returns { tenantId }, with expired/missing/revoked cookie returns 401 NextResponse.
**Depends on**: 2
**Parallelizable**: No

### Step 6: Implement lib/connections.ts (CRUD)
**What**: Implement platform_connections CRUD (create, read, list by tenant) and the encryption/decryption boundary (calls into lib/credentialCrypto.ts; no code path in this step returns a decrypted credential). Every function takes tenantId as an explicit first parameter and includes it in all WHERE clauses.
**Files**: lib/connections.ts
**Test**: Unit tests verifying: cross-tenant reads return empty, create round-trips correctly through encrypt/decrypt, list is scoped to tenant_id.
**Depends on**: 1c, 4
**Parallelizable**: Yes

### Step 7: Implement kill-switch functions in lib/connections.ts
**What**: Implement recordSuspensionSignal (atomically transition `status` and insert a connection_status_events audit row in a single db.transaction()) and reactivateConnection (moves `suspended` → `active`; rejects `revoked` connections — no path back within this increment). This is the kill-switch's own functional area per requirements.md's "Automatic kill-switch" section, verified independently of basic CRUD.
**Files**: lib/connections.ts
**Test**: Unit tests verifying: suspension signal atomically updates status and audit log within one transaction, reactivate rejects revoked connections, reactivate on an already-active connection errors per contract.
**Depends on**: 6
**Parallelizable**: No

### Step 8: Implement lib/consent.ts
**What**: Implement getCurrentDisclosureVersion, recordConsent, revokeConsent (sets revoked_at), and hasValidConsent (checks for non-revoked consent matching current disclosure version). Consent is scoped per tenant+connection pair.
**Files**: lib/consent.ts
**Test**: Unit tests verifying: per-tenant-per-platform scoping, consent resets when disclosure version bumps, revocation invalidates immediately.
**Depends on**: 1d
**Parallelizable**: Yes

### Step 9: Implement lib/automationGate.ts
**What**: Implement assertCanAutomate(tenantId, connectionId) as the single entry point future connector code must call before automation actions, checking connection status is active and consent is valid. Returns { ok: true } or { ok: false; reason }.
**Files**: lib/automationGate.ts
**Test**: Unit tests verifying: suspended/revoked connections block automation, missing/revoked consent blocks automation, active+consented connections allow it.
**Depends on**: 7, 8
**Parallelizable**: No

### Step 10: Create auth routes (signup, login, logout)
**What**: Create POST /api/auth/signup (email + password → tenant + session cookie), POST /api/auth/login (email + password verification + session), POST /api/auth/logout (session revocation + cookie clear).
**Files**: app/api/auth/signup/route.ts, app/api/auth/login/route.ts, app/api/auth/logout/route.ts
**Test**: E2E test: sign up new tenant, login returns same tenant_id, logout invalidates session for next request; assert the session cookie is set with `httpOnly` (and whatever other flags get decided during implementation, e.g. `sameSite`/`secure`) — cookie security must not be left untested.
**Depends on**: 2 (signup/login/logout are pre-auth by definition — they call lib/tenantAuth.ts directly and never call requireTenant())
**Parallelizable**: Yes

### Step 11: Create app/login/page.tsx and app/signup/page.tsx
**What**: Minimal functional login and signup pages — plain HTML forms posting to /api/auth/login and /api/auth/signup respectively, no styling required. Needed so the app remains usable through the browser after this increment ships.
**Files**: app/login/page.tsx, app/signup/page.tsx
**Test**: Submitting the signup form creates a tenant and receives a session cookie; submitting the login form with valid credentials sets the session cookie; invalid credentials show an error without a cookie being set.
**Depends on**: 10
**Parallelizable**: Yes

### Step 12: Create connection management routes (list/create/get)
**What**: Create GET /api/connections (list by tenant), POST /api/connections (create with encrypted credential — if a `revoked` connection already exists for `(tenant_id, platform)`, this reconnect path allows creating a fresh connection for that platform instead of a bare 409; only a live `active`/`suspended` connection blocks with 409), GET /api/connections/:id (metadata, 404 if missing or owned by a different tenant).
**Files**: app/api/connections/route.ts, app/api/connections/[id]/route.ts
**Test**: E2E test: create connection for tenant A, verify tenant B cannot read it (404 not 403); verify creating a new connection for a platform whose prior connection is `revoked` succeeds (reconnect path); verify creating one for a platform whose prior connection is still `active`/`suspended` returns 409.
**Depends on**: 5, 6
**Parallelizable**: Yes

### Step 13: Create credential-rotation and reactivate routes
**What**: Create PATCH /api/connections/:id/credential (rotate) and POST /api/connections/:id/reactivate (move from suspended to active).
**Files**: app/api/connections/[id]/credential/route.ts, app/api/connections/[id]/reactivate/route.ts
**Test**: E2E test: rotate credential and confirm re-encryption; call `recordSuspensionSignal()` directly (the same approach the kill-switch step's own unit tests use — no HTTP route triggers suspension in this increment) to move a connection to `suspended`, then call the reactivate endpoint and confirm it returns to `active`; confirm reactivate on a `revoked` connection returns 409.
**Depends on**: 12, 7
**Parallelizable**: Yes

### Step 14: Create consent and disclosure routes
**What**: Create GET /api/connections/:id/consent (has_valid_consent + version info), POST /api/connections/:id/consent (record new consent for current disclosure), DELETE /api/connections/:id/consent (revoke), and GET /api/disclosures/current (returns current version + content text, not tenant-scoped). Merged into one step since both are thin wrappers over lib/consent.ts.
**Files**: app/api/connections/[id]/consent/route.ts, app/api/disclosures/current/route.ts
**Test**: E2E test: consent required before automation, revoking consent blocks automation, old disclosure version triggers stale error; GET /api/disclosures/current returns the correct version number and text with no session cookie present at all.
**Depends on**: 8 (consent.ts) for every route in this step; 5 (requireTenant) additionally for the tenant-scoped `/api/connections/:id/consent` routes only — GET /api/disclosures/current is explicitly not tenant-scoped and does not depend on 5.
**Parallelizable**: Yes

### Step 15: Retrofit /api/items core routes with tenant_id filtering
**What**: Add requireTenant() call and tenant_id WHERE clause to: GET /api/items (list by tenant), POST /api/items (insert with tenant_id), GET/PATCH/DELETE /api/items/:id (own-tenant-only).
**Files**: app/api/items/route.ts, app/api/items/[id]/route.ts
**Test**: Run existing item tests via createTestTenant fixture; verify unauthenticated requests return 401, tenant A cannot mutate tenant B's item (404).
**Depends on**: 1b, 5, 3
**Parallelizable**: Yes

### Step 16: Phone-handoff auth carve-out
**What**: `app/api/phone-session/[token]/route.ts` and the `X-Pairing-Token` header upload path inside `app/api/items/[id]/photos/route.ts` must NOT receive `requireTenant()` — they resolve tenant scope via the pairing token → item → tenant_id (through `lib/pairingToken.ts`, whose lookup gains tenant-aware resolution) instead, since the paired phone never holds a session cookie. By contrast, `app/api/items/[id]/phone-session/route.ts` (issues a new pairing token, called by the tenant's own browser) DOES get `requireTenant()` normally as part of the regular route retrofit (Step 17). This step is referenced explicitly from Step 17 so the photos route isn't blanket-retrofitted with requireTenant() by mistake.
**Files**: app/api/phone-session/[token]/route.ts, app/api/items/[id]/photos/route.ts, lib/pairingToken.ts
**Test**: Verify a valid X-Pairing-Token request to the photos upload path succeeds with no session cookie present; verify a pairing token scoped to tenant A's item cannot be used to reach tenant B's item; verify requests to app/api/phone-session/[token]/route.ts resolve correctly via the token alone.
**Depends on**: 1b, 5
**Parallelizable**: Yes

### Step 17: Retrofit /api/items status and photos routes with tenant_id filtering
**What**: Add requireTenant() call and tenant_id WHERE clause to: PATCH /api/items/:id/status, GET/POST/DELETE /api/items/:id/photos (the session-cookie path only — see Step 16 for the X-Pairing-Token carve-out on this same file, which must NOT get requireTenant()), DELETE /api/items/:id/photos/:photoId, and app/api/items/[id]/phone-session/route.ts (gets requireTenant() normally per Step 16's note).
**Files**: app/api/items/[id]/status/route.ts, app/api/items/[id]/photos/route.ts, app/api/items/[id]/photos/[photoId]/route.ts, app/api/items/[id]/phone-session/route.ts
**Test**: Run existing item tests via createTestTenant fixture; verify unauthenticated requests return 401, tenant A cannot mutate tenant B's item (404); verify the X-Pairing-Token path from Step 16 still works unauthenticated and is unaffected by this retrofit.
**Depends on**: 15, 16, 5, 3
**Parallelizable**: Yes

### Step 18: Set tenant_id on price_history writes
**What**: Update the status-change logic that inserts price_history rows (lib/transitions.ts and/or the status route that calls it) to set tenant_id on insert, matching the parent item's tenant_id. price_history is a tenant-scoped satellite per requirements.md but was not otherwise touched by the item-route retrofits above.
**Files**: lib/transitions.ts, app/api/items/[id]/status/route.ts
**Test**: Trigger a status change for a tenant-scoped item; confirm the resulting price_history row's tenant_id equals the item's tenant_id.
**Depends on**: 17, 1b
**Parallelizable**: No

### Step 19: Update lib/dashboard.ts and retrofit /api/dashboard
**What**: Update lib/dashboard.ts's getDashboardData() function to take a tenantId: string parameter and thread it into all 5 of its internal SQL queries. Update app/api/dashboard/route.ts to call requireTenant() and pass the resolved tenantId through to getDashboardData(). Without this, dashboard stats leak across all tenants.
**Files**: lib/dashboard.ts, app/api/dashboard/route.ts
**Test**: Dashboard returns only the authenticated tenant's data across all 5 stat categories; unauthenticated returns 401; a second tenant's dashboard shows zero overlap with the first tenant's stats.
**Depends on**: 5, 1b
**Parallelizable**: Yes

### Step 20: Retrofit /api/export
**What**: Add requireTenant() call and tenant_id WHERE clause to GET /api/export.
**Files**: app/api/export/route.ts
**Test**: Export returns only the authenticated tenant's data, unauthenticated returns 401.
**Depends on**: 5, 1b
**Parallelizable**: Yes

### Step 21: Retrofit /api/import, /api/isbn, /api/suggestions
**What**: Add requireTenant() call and tenant_id filtering to: POST /api/import (insert with tenant_id), GET /api/isbn/:isbn, GET /api/items/suggestions.
**Files**: app/api/import/route.ts, app/api/isbn/[isbn]/route.ts, app/api/items/suggestions/route.ts
**Test**: Unauthenticated requests return 401; items created via import land on the authenticated tenant.
**Depends on**: 5, 1b, 3
**Parallelizable**: Yes

### Step 22: Write acceptance tests covering all 15 acceptance criteria
**What**: Implement integration tests covering: 401 on missing tenant (AC1), 404 (not 403) on cross-tenant read (AC2), cross-tenant credential isolation (AC3), no secret values in responses/logs (AC4-5), consent blocking automation (AC6-8), consent revocation blocking (AC9), suspension signal atomicity (AC10), suspension blocks automation mid-session (AC11), no auto-heal after suspend (AC12), migration runs cleanly (AC13), pre-existing inventory migrates to default tenant and flows still pass (AC14), CSRF middleware orthogonal to tenant auth (AC15).
**Files**: tests/api/auth.test.ts, tests/api/connections.test.ts, tests/api/consent.test.ts, tests/api/tenant-isolation.test.ts, tests/api/kill-switch.test.ts (or consolidated as appropriate)
**Test**: Run `npm test` and `npm run test:e2e`; all new tests pass, all pre-existing tests still pass.
**Depends on**: 1a-21 (all preceding steps)
**Parallelizable**: No

## Rollback plan

**Steps 1a-1d (migrations):** All reversible via git; delete the four new migration files and revert their four registration entries in lib/db.ts.

**Steps 2, 4-9 (libs):** Revert lib/tenantAuth.ts, lib/credentialCrypto.ts (and its vitest.config.ts/playwright.config.ts env additions), the requireTenant enhancement to lib/apiRequest.ts, lib/connections.ts, lib/consent.ts, and lib/automationGate.ts.

**Step 3 (test helpers):** Delete tests/helpers/tenant.ts and revert tests/setup.ts.

**Steps 10-11 (auth routes + pages):** Delete the new route files under app/api/auth/ and the new app/login/page.tsx, app/signup/page.tsx pages.

**Steps 12-14 (connection & consent routes):** Delete the new route files under app/api/connections/ and app/api/disclosures/. No existing routes are changed.

**Steps 15-21 (route retrofits):** Revert the requireTenant() calls and tenant_id WHERE clauses from the retrofitted route files (including the phone-handoff carve-out in Step 16, the price_history write in Step 18, and lib/dashboard.ts's getDashboardData() signature in Step 19) using git diff; no tables are dropped.

**Step 22 (acceptance tests):** Delete the new test files.

**Database risk:** The new migrations are append-only (ALTER TABLE ADD COLUMN with DEFAULT, and new CREATE TABLE). To reset a local dev database: delete data/inventory.db and data/credential.key, then restart the app to re-run all migrations from scratch against pre-existing inventory data (now on the default tenant).

**In production:** Do not delete data/inventory.db or data/credential.key. To roll back, revert the migrations array in lib/db.ts (the next app restart will see a lower PRAGMA user_version and skip the new migrations), then redeploy. Existing data will remain in the new columns/tables but will not be used. To fully reverse, a database restoration from before the migration is required.

All steps reversible via git.
