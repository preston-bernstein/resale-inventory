# Steps: Authentik Forward-Auth SSO Integration

## Prerequisites

- Caddy `forward_auth` block must be extended with `copy_headers` including `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, `X-Authentik-Email` (deployment config only, not app code — documented in step 12).
- Environment variables `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, `AUTHENTIK_AUDIENCE` will be unset in local dev; the feature gracefully skips forward-auth when unconfigured.
- Installed: Node 18+, npm, the working repo at HEAD of this branch with existing `lib/tenantAuth.ts` and `middleware.ts`.

## Implementation steps

### Step 2a: Add jose dependency and create JWKS caching module
**What**: Install `jose` (Web-Crypto-based JWT/JWKS library) into package.json. Implement a `lib/forwardAuth.ts` module with a module-level `JWKSet` (initialized lazily via `createRemoteJWKSet`, not a Map—there is only one pinned JWKS URL per deployment) that caches the remote public key set for re-verification within the cache window.
**Files**: `package.json`, `package-lock.json`, `lib/forwardAuth.ts` (new).
**Test**: `npm install` completes; `npm run build` succeeds; `tsc --noEmit` passes; confirm `jose` appears in `package.json` and `lib/forwardAuth.ts` exports the lazy-initialized `JWKSet`.
**Depends on**: None.
**Parallelizable**: No (prerequisite to step 2b).

### Step 2b: Implement verifyAuthentikJwt function with tests
**What**: Create `verifyAuthentikJwt(jwt: string): Promise<{ email: string } | null>` function in `lib/forwardAuth.ts` that uses the module-level `JWKSet`, pins `algorithms: ['RS256']` (or the specific asymmetric algorithm), `issuer`, and `audience` from env config; returns `null` on any verification failure (bad signature, expired, wrong iss/aud, `alg: none`, algorithm confusion). Write unit tests (`tests/api/forwardAuth.test.ts`) asserting a valid case (token signed with a known key decrypts correctly) and an invalid case (token with wrong signature or wrong algorithm is rejected).
**Files**: `lib/forwardAuth.ts` (extends 2a), `tests/api/forwardAuth.test.ts` (new).
**Test**: `npm run test:unit` passes; unit test explicitly asserts both a valid JWT and an invalid JWT, not just compile checks.
**Depends on**: Step 2a.
**Parallelizable**: No (depends on 2a).

### Step 3: Add findTenantByEmail helper to lib/tenantAuth.ts
**What**: Export a small helper `findTenantByEmail(email: string): string | null` that queries `SELECT id FROM tenants WHERE email = ? COLLATE NOCASE LIMIT 1`, reusing the existing `COLLATE NOCASE` uniqueness constraint; used by middleware to look up tenants by verified JWT email claim.
**Files**: `lib/tenantAuth.ts`.
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; unit test or inline verification confirms query returns matching tenant id (case-insensitive).
**Depends on**: None.
**Parallelizable**: Yes (with step 2b; different file, no cross-dependency).

### Step 4: Update middleware.ts to Node.js runtime and widen matcher
**What**: Add `export const config = { runtime: 'nodejs' }` (stable in `next@15.5.19`); change `matcher` from `['/api/:path*']` to `['/((?!_next/static|_next/image|favicon.ico|public/manifest.json|public/icon-192.png|public/icon-512.png|public/.*\\.svg).*))']` so forward-auth runs on both API calls and page navigations (FR7 requires session setup on page requests, not just `/api/*`), while excluding static assets and manifest to avoid unnecessary DB round-trips.
**Files**: `middleware.ts`.
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; confirm middleware.ts exports the `config` object with `runtime: 'nodejs'`; manual smoke test: `npm run dev` and hit a non-API page (e.g. `/`) to confirm the page loads without errors.
**Depends on**: None.
**Parallelizable**: No (prerequisite to step 5, which refactors the same file).
**Important**: Steps 4–6 must be landed together as a single deployable unit. Do not merge Step 4 alone without Step 5–6 following immediately; the widened matcher with only CSRF logic is an untested intermediate state.

### Step 5: Extract checkCsrf helper in middleware.ts
**What**: Move existing CSRF origin-check logic from `middleware()` into a named `checkCsrf(request: NextRequest): NextResponse | null` helper; call it first in middleware, return early if it rejects. Preserve existing CSRF behavior unchanged (only acts on mutating `/api/*` methods).
**Files**: `middleware.ts`.
**Test**: `npm run build` succeeds; existing CSRF test suite still passes (if CSRF tests exist); CSRF reject/allow outcomes are unchanged.
**Depends on**: Step 4.
**Parallelizable**: No.

### Step 6: Implement applyForwardAuth logic in middleware.ts (with async refactor)
**What**: Make `middleware()` async (required because `jose.jwtVerify` is Promise-based). Add `applyForwardAuth(request: NextRequest, response: NextResponse): Promise<NextResponse>` function that:
  1. Checks if `reseller_session` cookie is present and valid (via `resolveSession()`); if yes, pass through untouched (FR9/AC5).
  2. Checks if `X-Authentik-Jwt` header is present; if no, pass through untouched (FR10/AC2).
  3. Calls `verifyAuthentikJwt(jwtHeader)` from `lib/forwardAuth.ts`; on failure (null return), pass through untouched (FR1/FR3/FR4/AC3).
  4. On verification success, extracts email claim from verified payload; calls `findTenantByEmail(email)` from `lib/tenantAuth.ts`.
  5. If tenant found: calls `createSession(tenantId)` and `setSessionCookie(response, ...)` to establish session; **rewrites the request's own `Cookie` header** (via `NextResponse.next({ request: { headers: newHeadersWithCookieInjected } })`) so the same request is treated as authenticated by the downstream page component (AC1: no redirect); returns response with cookie (FR5/FR6/FR7/FR12/AC1).
  6. If tenant not found: **explicitly exempt** `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`, `/login`, and `/signup` from the unmatched-tenant reject branch (allow these requests to proceed so a new Authentik-authenticated user can create a tenant); for all other routes, return `403 { "error": "authentik_identity_unmatched" }` for `/api/*` routes, or `302` redirect to `/login?sso_error=unmatched` for page routes (FR8/AC4).
  Call `applyForwardAuth()` after `checkCsrf()` in the main `middleware()` function. **Critical fix**: Update all 4 call sites in `tests/api/tenant-isolation.test.ts` that call `middleware(req)` synchronously inside the `describe('AC15: CSRF middleware ...')` block to `await middleware(req)`.
**Files**: `middleware.ts`, `lib/forwardAuth.ts` (may need minor adjustments to exports), `tests/api/tenant-isolation.test.ts` (update 4 call sites to await).
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; verify middleware does not break any existing behavior when no Authentik headers present via manual smoke test of the no-header pass-through case specifically. Full branch coverage for all 6 branches verified by Steps 8/9's automated tests (not this step alone).
**Depends on**: Steps 2b, 3, 5.
**Parallelizable**: No.
**Important**: Steps 4–6 must be landed together as a single deployable unit (see Step 4 note).

### Step 7: Update app/login/page.tsx to display SSO error banner
**What**: Create a small inner client component `<SsoErrorBanner>` (wrapped in `<Suspense>` boundary in `app/login/page.tsx` to read `useSearchParams()` safely in the App Router) that reads the `sso_error` search param; if `sso_error === 'unmatched'`, render a distinct banner ("Your SSO login isn't linked to a reseller account yet. Log in with email/password below, or contact the operator.") above the existing login form; existing form and submit logic unchanged. The Suspense boundary is required because `useSearchParams()` at the top level of a page component is a known Next.js build/render issue.
**Files**: `app/login/page.tsx`.
**Test**: `npm run dev` locally; navigate to `/login?sso_error=unmatched`; verify banner renders without Suspense fallback; verify form still works.
**Depends on**: Step 6.
**Parallelizable**: No (depends on Step 6's response-shape contract for `sso_error=unmatched`).

### Step 8: Write unit tests for forwardAuth.ts
**What**: Create `tests/api/forwardAuth.test.ts` with Vitest; test:
  - `verifyAuthentikJwt()` with a valid token (mocked via `jose.createLocalJWKSet` / `jose.SignJWT` fixture).
  - Expired token (JWT with past `exp` claim).
  - Wrong issuer / audience (token's `iss` or `aud` do not match env config).
  - `alg: none` (token header specifies unsigned).
  - Algorithm confusion (token uses different algorithm than pinned).
  - Malformed JWKS response (e.g. missing `keys` array).
  - JWKS endpoint network failure/timeout: must result in `verifyAuthentikJwt` returning null (fail closed).
  - `findTenantByEmail()` with matching and non-matching email (requires a test database or mock).
**Files**: `tests/api/forwardAuth.test.ts` (new).
**Test**: `npm run test:unit` passes for this file; coverage thresholds met (85/80/85/85 per constraints).
**Depends on**: Steps 2a, 2b, 3.
**Parallelizable**: Yes (with steps 4–7, after steps 2a–2b complete).

### Step 9: Write middleware tests for forward-auth behavior and verify CSRF protection
**What**: Create `tests/api/forwardAuthMiddleware.test.ts` or extend existing middleware tests to cover:
  - Skip-if-valid-session path (FR9/AC5): request with existing valid `reseller_session` cookie is not re-verified; session is not duplicated.
  - No-header pass-through path (FR10/AC2): request without `X-Authentik-Jwt` passes through as if forward-auth did not run.
  - Forged plaintext headers without JWT (threat model): request with `X-Authentik-Username`, `X-Authentik-Email`, `X-Authentik-Groups` headers but NO `X-Authentik-Jwt` header must be ignored exactly like the no-header case.
  - JWKS-not-refetched-per-request (FR11/AC8): spy/mock the JWKS fetcher; assert it is called once, then subsequent requests reuse the cached key set within the cache window.
  - Unmatched-tenant response shape (FR8/AC4): `/api/verify` call with verified JWT but no matching tenant returns `403 { "error": "authentik_identity_unmatched" }`; page request returns `302` to `/login?sso_error=unmatched`.
  - CSRF interaction (AC7): cross-origin mutating request with Authentik headers present is still rejected by CSRF check (headers do not bypass CSRF protection).
  - All env vars unset: with `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, `AUTHENTIK_AUDIENCE` all unset, middleware behaves exactly as it does today (forward-auth entirely skipped).
  - Partial env config causing startup error: with only `AUTHENTIK_JWKS_URL` and `AUTHENTIK_ISSUER` set but `AUTHENTIK_AUDIENCE` unset, app fails to start with a clear error (not silently degrading verification).
  - Verify existing CSRF tests still pass: after the async-middleware refactor, re-run all CSRF-related test cases to confirm that widening the middleware matcher (step 4) does not regress CSRF rejection for cross-origin mutating requests. After the `tests/api/tenant-isolation.test.ts` await-fix is complete, run the FULL existing test suite once to confirm zero regressions beyond the 4 fixed call sites.
**Files**: `tests/api/forwardAuthMiddleware.test.ts` (new) or extend `tests/api/middleware.test.ts`; `tests/api/tenant-isolation.test.ts` (update 4 call sites to await, per Step 6).
**Test**: `npm run test:unit` passes; coverage thresholds met; CSRF tests show zero new failures.
**Depends on**: Step 6.
**Parallelizable**: No (depends on middleware implementation).

### Step 10a: Build and validate mock JWKS HTTP server fixture
**What**: Create `tests/e2e/fixtures/mockJwksServer.ts` (or similar) with a local mock JWKS endpoint (tiny `http.createServer` fixture, no live Authentik instance) that serves a valid JWKS public key. Build the fixture as a reusable module so it can be started/stopped in test setup/teardown.
**Files**: `tests/e2e/fixtures/mockJwksServer.ts` (new).
**Test**: `npm run test:e2e` (this fixture only, or a small fixture-validation test) passes; mock server starts, serves valid JWKS, and can be cleanly torn down.
**Depends on**: Steps 2b, 3.
**Parallelizable**: Yes (independent of middleware tests).

### Step 10b: Write Playwright E2E test with mocked JWKS
**What**: Create `tests/e2e/forward-auth.spec.ts` using the mock JWKS server fixture from Step 10a. Test the full flow:
  1. Mock server starts (from fixture), serving JWKS at a test URL.
  2. Inject `X-Authentik-Jwt`, `X-Authentik-Email`, `X-Authentik-Username` headers into a test request (e.g. via fetch or playwright.fetch, simulating Caddy's forward-auth behavior).
  3. Verify the request succeeds and sets `reseller_session` cookie (header-in → cookie-out).
  4. Verify a second request with that cookie does not need new Authentik headers to work.
  Satisfies "mockable JWKS/JWT" NFR and AC10 (local-suite Playwright exercise).
**Files**: `tests/e2e/forward-auth.spec.ts` (new).
**Test**: `npm run test:e2e` passes; test successfully exercises the full flow without a live Authentik instance.
**Depends on**: Steps 2a–7, 10a.
**Parallelizable**: No (depends on complete implementation).

### Step 11: Document required Caddyfile deployment changes and verification
**What**: Create `docs/AUTHENTIK-DEPLOYMENT.md` (or similar) documenting:
  - The required Caddyfile `forward_auth` block's `copy_headers` list must include `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, `X-Authentik-Email` (in addition to existing `X-Authentik-Username`, `X-Authentik-Groups`).
  - Environment variables required: `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, `AUTHENTIK_AUDIENCE`.
  - A manual smoke-test procedure: user authenticates with Authentik, visits the deployed app, should not see the login form (AC1).
  - Why this feature fails silently if Caddyfile is not updated (header-absent path in step 6), and how to notice the miss.
**Files**: `docs/AUTHENTIK-DEPLOYMENT.md` (new).
**Test**: (a) Documentation review — no dependency, can be done any time; (b) Post-deploy smoke test — depends on Steps 1–10b being merged AND the Caddyfile actually updated on the deploy host, run manually once against the real deployed instance to confirm AC1 (no redirect to login for authenticated Authentik user with matching tenant).
**Depends on**: None (documentation only; (a) review part has no dependency; (b) smoke test part depends on full implementation being deployed).
**Parallelizable**: Yes (documentation writing).

## Rollback plan

**Steps 2a–2b, 3, 7:** Revertible via `git revert` (dependency additions, small module creation, page component update).

**Steps 4–6 (middleware refactoring):** Combined refactoring of `middleware.ts` and related tests. Must not be deployed independently — Steps 4–6 land together as a single deployable unit. To rollback, revert in this order (to avoid merge conflicts):
  1. Revert Step 6 (`applyForwardAuth` logic and async middleware).
  2. Revert Step 5 (helper extraction).
  3. Revert Step 4 (config export and matcher widening).
  Middleware will fall back to the original `/api/:path*` matcher and unchanged CSRF-only logic.

**Steps 8–10b (tests):** Revert test files via `git revert`. Tests are not part of the running application, so removing them leaves the feature code intact.

**Step 11 (documentation):** Remove or revert the documentation file.

**External dependency (Caddyfile):** If deployed with incorrect or missing `copy_headers` extension, revert by editing the Caddyfile to remove the added headers (`X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, `X-Authentik-Email`) and restarting the caddy container. No app-code rollback needed; the app tolerates the header's absence as its normal "not configured" state.

All steps reversible via `git revert` or direct file editing. No data migration or schema change required.
