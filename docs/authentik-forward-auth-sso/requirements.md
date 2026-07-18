# Requirements: Authentik Forward-Auth SSO Integration

## Problem statement
The resale-inventory app is fronted publicly at resale-inventory.houseoflight.dev by an existing Caddy `forward_auth authentik-server:9000` block that gates every request through Authentik before it reaches the app on 127.0.0.1:3010. The app has its own, separate tenant auth (`lib/tenantAuth.ts`, email/password, its own `tenants` table, its own `reseller_session` cookie) that has never been wired to read Authentik's identity, so a user who just authenticated with Authentik is dropped on the app's own login form and has to log in a second time with a different credential set. This is a usability regression introduced by fronting an app that was designed to run auth-less on localhost, and it will affect every user of the deployed instance until fixed.

## Users / stakeholders
- The operator (Preston), the only real tenant of the deployed instance today, who hits the double-login on every fresh browser session.
- Any additional tenant accounts created under the multi-tenant foundation who access the app via the public Authentik-fronted URL.
- The existing email/password login path's users on non-Authentik-fronted access (local `npm run dev`, Tailscale/LAN access per `docs/PHONE-ACCESS.md`), who must be unaffected.
- CI / the test suite, which must be able to exercise the new logic without a live Authentik instance.

## Functional requirements
1. The system shall treat the plaintext `X-Authentik-Username`, `X-Authentik-Email`, and `X-Authentik-Groups` headers as untrusted input for any authentication decision — they shall never by themselves cause a session to be created.
2. The system shall verify the `X-Authentik-Jwt` header's signature against a JWKS endpoint pinned via server-side configuration (`AUTHENTIK_JWKS_URL`) before deriving any identity from the request. The URL value carried in the `X-Authentik-Meta-Jwks` request header shall never be used as the fetch target — it is untrusted, attacker-forgeable input (an attacker able to forge headers could equally forge a JWKS URL pointing at a key server they control) and must be treated as informational only.
3. The system shall reject the JWT (i.e. treat the request as not authenticated by Authentik) when signature verification fails, the token is expired, its `iss` claim does not exactly match the `AUTHENTIK_ISSUER` server-side config value, or its `aud` claim does not exactly match the `AUTHENTIK_AUDIENCE` server-side config value. Both `AUTHENTIK_ISSUER` and `AUTHENTIK_AUDIENCE` are resolved via deployment-time environment configuration; no default value is assumed by this spec.
4. The system shall reject any JWT whose header `alg` is not exactly `RS256` (Authentik's proxy-provider default signing algorithm) — an unsigned token (`alg: none`) or an algorithm-substitution attempt shall never verify.
5. The system shall treat `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, and `AUTHENTIK_AUDIENCE` as an all-or-nothing configuration set: if any one of the three is set, all three must be set, or the application shall fail to start with a clear error, rather than silently degrading verification strength by skipping an unset check.
6. The system shall extract the identity claim from the verified JWT's `email` claim only, never from the plaintext headers, once signature verification succeeds. Email is the sole identity/mapping claim for this increment; no alternate claim is supported.
7. The system shall look up an existing tenant by the verified identity, matching `tenants.email` case-insensitively (consistent with the table's existing `COLLATE NOCASE` uniqueness), whenever the request does not already carry a valid `reseller_session` cookie.
8. When a matching tenant is found and no valid session cookie is already present, the system shall create a new tenant session via the existing `createSession`/`setSessionCookie` functions in `lib/tenantAuth.ts` and attach the `reseller_session` cookie to the response, so the request completes without redirecting to the app's own login form.
9. When the verified identity has no matching tenant record, the system shall not auto-provision a tenant and shall not establish a session from it. The request shall receive a distinct, documented response: for `/api/*` routes, a `403` response with body `{"error": "authentik_identity_unmatched"}`; for all other (page) routes, a `302` redirect to `/login?sso_error=unmatched`.
10. The forward-auth session-establishment check (FR7-FR9) shall apply to page navigations as well as `/api/*` calls, not only API routes — this is required for FR8 to actually eliminate the login-page redirect for page requests, consistent with Constraint 4's note about middleware's matcher needing to widen.
11. The forward-auth identity-check (FR7-FR9) shall not apply to `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`, `/login`, or `/signup` — these routes remain reachable via the app's existing manual auth flow regardless of Authentik headers present on the request.
12. The system shall skip forward-auth-derived session establishment entirely when the request already carries a valid, unexpired, unrevoked `reseller_session` cookie (as determined by the existing `resolveSession`).
13. The system shall continue to accept the existing `/api/auth/login` email/password path unchanged for requests that do not carry a verifiable `X-Authentik-Jwt` (e.g. local dev, or Tailscale/LAN access per `docs/PHONE-ACCESS.md` that isn't routed through Authentik).
14. The system shall fetch JWKS keys only on a cache miss, using the JWT/JWKS library's built-in remote-set caching, never fetching the JWKS endpoint on every incoming request.
15. The system shall apply the same session cookie flags (`httpOnly`, `sameSite=lax`, `secure` in production) to Authentik-derived sessions as to password-derived sessions, by routing both through the same `setSessionCookie` code path.

## Non-functional requirements
- Security: JWT signature verification against JWKS is mandatory and fails closed — a missing, malformed, or unverifiable JWT must never be treated as equivalent to a verified one, even though plaintext identity headers are present.
- Security: algorithm confusion is explicitly rejected — the verifier pins `RS256` rather than trusting whatever `alg` the token header claims.
- Security: this defends specifically against a local process on the app's host forging headers directly to 127.0.0.1:3010 (the app is not otherwise network-exposed, but that binding alone is not sufficient protection once headers are trusted).
- Security: once an Authentik-derived `reseller_session` is established, session validity is not re-checked against the Authentik JWT/IdP for the remaining life of that session (same behavior as a password-derived session) — an Authentik-side account disable/de-group takes up to the full session TTL to take effect app-side. This is an accepted risk, consistent with Out of scope's "no renegotiated TTL" item, not a silent gap.
- Performance: JWKS verification must not add a network round trip to Authentik on every request — see FR14 (cache-miss-only fetching).
- Compatibility: the existing CSRF origin-check in `middleware.ts` for mutating `/api/*` requests must not be weakened or bypassed by the new logic.
- Testability: the new verification logic must be exercisable in the local Vitest/Playwright suites without a live Authentik instance (mockable JWKS/JWT).
- Scale: this app is single-instance/local-first (per README) — no multi-instance JWKS cache invalidation or distributed-session concerns are assumed.

## Constraints
- Must integrate with the existing Caddy `forward_auth authentik-server:9000` block. Its `copy_headers` list currently forwards only `X-Authentik-Username` and `X-Authentik-Groups` — it must be extended to also forward `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, and `X-Authentik-Email` for this feature to have anything to verify. This Caddyfile change is a prerequisite, in scope as a deployment-config change alongside the app code.
- Must reuse the existing tenant session mechanism in `lib/tenantAuth.ts` (`createSession`, `resolveSession`, `setSessionCookie`, `SESSION_COOKIE_NAME`) rather than introducing a second, parallel session system.
- Must map identity onto the existing `tenants` table (`id`, `email` UNIQUE COLLATE NOCASE, `password_hash`) using email as the sole mapping claim, with no assumed schema change.
- `middleware.ts` currently matches only `/api/:path*` and does CSRF origin-checking exclusively. Establishing a session for page navigation (not just API calls) requires either extending its matcher or adding an equivalent check elsewhere, without regressing its existing CSRF behavior.
- The app must keep working unauthenticated-by-Authentik for non-fronted access paths (local dev, Tailscale/LAN per `docs/PHONE-ACCESS.md`) — this feature is additive, not a replacement for the existing login.
- Testing bar is fixed by the project: Vitest coverage thresholds (85/80/85/85), Playwright E2E, Stryker mutation testing, `tsc --noEmit`, ESLint strict, and `fallow` — all CI-enforced; new code must clear all of them.
- `tests/e2e-deployed/authentik-auth.setup.ts` already exists and drives a real Authentik flow against the deployed instance for the deployed-only Playwright suite — it is a fixture for verifying the deployed environment, not a substitute for local-suite coverage of the new verification logic.

## Out of scope
- Auto-provisioning a new tenant when a verified Authentik identity has no matching tenant record — flagged as an explicit decision point (FR9), not built in this increment.
- Propagating Authentik logout/single-sign-out to the app's own session — an Authentik-side logout does not revoke the `reseller_session` cookie in this increment.
- App-level logout (`/api/auth/logout`) does not terminate the Authentik/outpost session — a user who logs out of the app while their Authentik session is still active will be silently re-authenticated via forward-auth on their very next request. This is a known, accepted limitation of this increment, not a bug to fix here.
- Any change to, or removal of, the existing email/password login, signup, or logout endpoints.
- Authorization/permission mapping from `X-Authentik-Groups` (or any other group/role claim) onto app-level permissions — this feature only establishes identity/session, not role-based access control.
- Any change to the multi-tenant isolation model or to tenant data schema beyond what identity-to-tenant mapping strictly requires.
- MFA or step-up authentication policy.
- Managing or rotating Authentik's own signing keys, outpost, or provider configuration, beyond the Caddyfile `copy_headers` change.
- Changing the app session's lifetime/TTL behavior — Authentik-established sessions use the existing `SESSION_TTL_MS` (7 days), not a renegotiated value tied to the Authentik token's own expiry.

## Acceptance criteria
1. A request through Caddy's forward_auth carrying a valid, signature-verified `X-Authentik-Jwt` whose identity claim matches an existing tenant's email results in a `reseller_session` cookie being set and the request succeeding, with no redirect to `/api/auth/login`.
2. A request with no `X-Authentik-Jwt` header is not auto-logged-in; the app's existing unauthenticated/login behavior applies unchanged.
3. A request with a present but invalid `X-Authentik-Jwt` (bad signature, expired, wrong issuer/audience, or `alg` other than `RS256`) never results in a session being created, regardless of what the plaintext `X-Authentik-Username`/`X-Authentik-Email`/`X-Authentik-Groups` headers say.
4. A verified Authentik identity with no matching tenant email does not create a tenant or a session, and produces the defined response — a `403` with body `{"error": "authentik_identity_unmatched"}` for `/api/*` routes, or a `302` redirect to `/login?sso_error=unmatched` for page routes — rather than an ambiguous failure or silent pass-through.
5. A request that already carries a valid `reseller_session` cookie is unaffected by forward-auth headers present on that same request — no duplicate session is created, no behavior changes.
6. The existing `/api/auth/login`, `/api/auth/signup`, and `/api/auth/logout` endpoints pass their existing test suites unmodified after this feature ships.
7. A first-time Authentik user with a valid, signature-verified `X-Authentik-Jwt` and no matching tenant record can still reach and complete `POST /api/auth/signup`, `GET /login`, and `GET /signup` — the forward-auth identity-check does not intercept or reject requests to these routes.
8. The existing CSRF origin-check for mutating `/api/*` requests still rejects a cross-origin mutation attempt after the new logic is added.
9. A page navigation (not an `/api/*` call) carrying a valid, signature-verified `X-Authentik-Jwt` and no `reseller_session` cookie results in a session being established and the page served directly, exercising the same identity-check as `/api/*` requests.
10. JWKS keys are fetched on a cache miss and reused across subsequent requests without re-fetching, verified by a test asserting the JWKS endpoint is not hit on every request.
11. The application fails to start with a clear error when only one or two of `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, and `AUTHENTIK_AUDIENCE` are set, rather than starting with partial verification.
12. All new code paths meet the project's coverage thresholds (85/80/85/85), pass Stryker mutation testing, `tsc --noEmit`, ESLint, and `fallow` in CI.
13. A local-suite Playwright (or Vitest) test exercises the full forward-auth-to-app-session flow using a mocked JWKS/JWT fixture, with no dependency on a live Authentik instance.
