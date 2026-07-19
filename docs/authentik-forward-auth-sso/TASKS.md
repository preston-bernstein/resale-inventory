# Tasks: Authentik Forward-Auth SSO Integration

Generated from: docs/authentik-forward-auth-sso/ on 2026-07-18

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Add jose dependency and create JWKS caching module (Step 2a)
**Status**: [x] done
**Files**: package.json, package-lock.json, lib/forwardAuth.ts (new)
**Test**: `npm install` completes; `npm run build` succeeds; `tsc --noEmit` passes; confirm `jose` in package.json and lib/forwardAuth.ts exports the lazy-initialized JWKSet.
**Depends on**: none
**Parallelizable**: no (prerequisite to Task 2)
**Notes**: jose ^6.2.3 installed. lib/forwardAuth.ts implements all-or-nothing env validation (AUTHENTIK_JWKS_URL/ISSUER/AUDIENCE), https:// validation on the JWKS URL, and a lazily-initialized getJwksSet() wrapping createRemoteJWKSet with a 5s timeoutDuration. tsc + build both pass.

### Task 2: Implement verifyAuthentikJwt function with tests (Step 2b)
**Status**: [x] done
**Files**: lib/forwardAuth.ts (extends Task 1), tests/api/forwardAuth.test.ts (new)
**Test**: `npm run test:unit` passes; unit test explicitly asserts both a valid JWT and an invalid JWT, not just compile checks.
**Depends on**: Task 1
**Parallelizable**: no
**Notes**: verifyAuthentikJwt implemented (jose.jwtVerify pinning RS256/issuer/audience, returns null never throws). 7 tests passing (valid, wrong signature, alg:none, wrong issuer, missing email, malformed token, unconfigured env) via vi.mock of createRemoteJWKSet backed by createLocalJWKSet. Full suite: 1903 passed (1 pre-existing stub failure in forwardAuthMiddleware.test.ts — expected, that's Task 9's file).

### Task 3: Add findTenantByEmail helper to lib/tenantAuth.ts (Step 3)
**Status**: [x] done
**Files**: lib/tenantAuth.ts
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; unit test confirms case-insensitive match.
**Depends on**: none
**Parallelizable**: yes (with Task 2; different file, no cross-dependency)
**Notes**: findTenantByEmail(email): string | null added next to verifyPassword, same COLLATE NOCASE pattern. Build + tsc pass.

### Task 4: Update middleware.ts to Node.js runtime and widen matcher (Step 4)
**Status**: [x] done
**Files**: middleware.ts
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; confirm middleware.ts exports config with runtime:'nodejs'; manual smoke test via `npm run dev`, hit a non-API page (e.g. `/`) to confirm it loads.
**Depends on**: none
**Parallelizable**: no (prerequisite to Task 5; Tasks 4-6 must land as one deployable unit — do not merge Task 4 alone)
**Notes**: runtime:'nodejs' added; matcher widened to exclude _next/static, _next/image, favicon.ico, and all known public/ static assets. No next.config.ts change needed — Node.js middleware runtime works natively at next@15.5.19, resolving the plan's open risk. Smoke test confirmed 200 on `/` and `/manifest.json`. middleware() body left untouched.

### Task 5: Extract checkCsrf helper in middleware.ts (Step 5)
**Status**: [x] done
**Files**: middleware.ts
**Test**: `npm run build` succeeds; existing CSRF test suite still passes; CSRF reject/allow outcomes unchanged.
**Depends on**: Task 4
**Parallelizable**: no
**Notes**: checkCsrf(request): NextResponse | null extracted; middleware() calls it and falls through to NextResponse.next() otherwise. 19 existing CSRF tests still pass unchanged. Build + tsc pass.

### Task 6: Implement applyForwardAuth logic in middleware.ts, async refactor, path exemptions, same-request cookie fix, tenant-isolation.test.ts await fix (Step 6)
**Status**: [x] done
**Files**: middleware.ts, lib/forwardAuth.ts (minor export adjustments), tests/api/tenant-isolation.test.ts (update 4 sync `middleware(req)` call sites at lines 259, 270, 279, 288 to `await middleware(req)`)
**Test**: `npm run build` succeeds; `tsc --noEmit` passes; manual smoke test of no-header pass-through case. Full branch coverage verified by Tasks 8/9's automated tests.
**Depends on**: Tasks 2, 3, 5
**Parallelizable**: no
**Notes**: DONE. applyForwardAuth implemented with path exemptions, cookie-session short-circuit, missing-header passthrough, JWT verification, tenant lookup/reject/redirect, and the same-request Cookie-header rewrite alongside setSessionCookie. middleware() is now async. tests/api/tenant-isolation.test.ts's 4 await fixes applied. Verified: tsc clean, build succeeds, all 19 tenant-isolation tests pass, manual dev-server smoke test confirms /login,/signup,/inventory return 200 and /api/dashboard still 401s with no header.

### Task 7: Update app/login/page.tsx to display SSO error banner (Step 7)
**Status**: [x] done
**Files**: app/login/page.tsx
**Test**: `npm run dev`; navigate to `/login?sso_error=unmatched`; verify banner renders without Suspense fallback issue; verify form still works.
**Depends on**: Task 6
**Parallelizable**: no (depends on Task 6's sso_error=unmatched contract)
**Notes**: DONE. SsoErrorBanner inner client component reads sso_error via useSearchParams(), wrapped in <Suspense>; form untouched. tsc + build pass.

### Task 8: Write unit tests for forwardAuth.ts (Step 8)
**Status**: [x] done
**Files**: tests/api/forwardAuth.test.ts (new)
**Test**: `npm run test:unit` passes for this file; coverage thresholds met (85/80/85/85).
**Depends on**: Tasks 1, 2, 3
**Parallelizable**: yes (with Tasks 4-7, after Tasks 1-2 complete)
**Notes**: 14 total tests pass (7 from Task 2 + 7 new: expired token, wrong audience, RS256-to-HS256 alg-confusion attack, JWKS-resolver-throws, JWKS-resolver-rejects/timeout, findTenantByEmail case-insensitive match + no-match).

### Task 9: Write middleware tests for forward-auth behavior and verify CSRF protection (Step 9)
**Status**: [x] done
**Files**: tests/api/forwardAuthMiddleware.test.ts (new), tests/api/tenant-isolation.test.ts (verify await fix from Task 6, run full suite)
**Test**: `npm run test:unit` passes; coverage thresholds met; CSRF tests show zero new failures.
**Depends on**: Task 6
**Parallelizable**: no
**Notes**: DONE. 10 tests in forwardAuthMiddleware.test.ts (session skip, no-header pass-through, forged-plaintext-headers threat scenario, path exemption, unmatched-tenant 403/redirect, session establishment, CSRF-vs-Authentik-headers). Caught a real bug: middleware.ts's redirect defaulted to 307, not the 302 requirements.md/AC4 specifies — fixed directly in middleware.ts (NextResponse.redirect(url, 302)) and the test assertion updated to match. Full suite 1920 tests + coverage 95/91/94/96% (above 85/80/85/85 threshold), zero regressions in tenant-isolation.test.ts's 19 tests.

### Task 10: Build and validate mock JWKS HTTP server fixture (Step 10a)
**Status**: [x] done
**Files**: tests/e2e/fixtures/mockJwksServer.ts (new)
**Test**: Fixture starts, serves valid JWKS, and can be cleanly torn down.
**Depends on**: Tasks 2, 3
**Parallelizable**: yes (independent of middleware tests)
**Notes**: startMockJwksServer() implemented (http.createServer, jose-generated RS256 keypair, serves {keys:[...]}, signToken() + stop()). Validated via throwaway script (deleted). tsc clean. FLAGGED FOR TASK 11: fixture serves plain http://, but lib/forwardAuth.ts requires https:// at module load — Task 11 must resolve this (e.g. self-signed HTTPS for the fixture, scoped to test env only, not a production code relaxation).

### Task 11: Write Playwright E2E test with mocked JWKS (Step 10b)
**Status**: [x] done
**Files**: tests/e2e/forward-auth.spec.ts (new), tests/e2e/globalSetup.ts (new), tests/e2e/fixtures/mockJwksServer.ts (extended), playwright.config.ts, lib/forwardAuth.ts (narrowly-scoped fix, see notes)
**Test**: `npm run test:e2e` passes; exercises full flow without a live Authentik instance.
**Depends on**: Tasks 1-7, 10
**Parallelizable**: no (depends on complete implementation)
**Notes**: DONE. Added a narrowly-scoped loopback exception (127.0.0.1/localhost, non-production only) to lib/forwardAuth.ts's https://-only check, needed because the mock JWKS server serves plain http:// and the real next-dev app process needs AUTHENTIK_JWKS_URL set before it boots. Solved the cross-process port-timing problem: mockJwksServer.ts gained a fixed-port mode + a /sign HTTP endpoint so the spec file (a separate process from Playwright's globalSetup) can request signed tokens over HTTP rather than needing in-process private-key access. New tests/e2e/globalSetup.ts starts the mock server before next dev boots; playwright.config.ts wires in the 3 AUTHENTIK_* env vars + globalSetup. forward-auth.spec.ts: signs up a real tenant, mints a JWT via the mock server, hits /dashboard with X-Authentik-Jwt + no cookie (200, no redirect, reseller_session cookie set), re-hits with only the cookie (200). Full suite verified: 1920 vitest + 53 Playwright tests pass, tsc + eslint clean.

### Task 12: Document required Caddyfile deployment changes and verification (Step 11)
**Status**: [x] done (documentation portion; post-deploy smoke test still pending actual deployment)
**Files**: docs/AUTHENTIK-DEPLOYMENT.md (new)
**Test**: (a) Documentation review — no dependency; (b) post-deploy smoke test depends on Tasks 1-11 merged AND Caddyfile updated on deploy host — run manually once against the real deployed instance.
**Depends on**: none (documentation only; (b) portion depends on full implementation being deployed)
**Parallelizable**: yes
**Notes**: docs/AUTHENTIK-DEPLOYMENT.md written: Caddyfile copy_headers extension, 3 required env vars (all-or-nothing), manual smoke-test procedure, and why the feature fails silently (not loudly) if the Caddyfile isn't updated.

## Blocked / open
(none yet)
