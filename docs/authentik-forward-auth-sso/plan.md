# Plan: Authentik Forward-Auth SSO Integration

## Approach

Verify the Authentik-issued JWT and establish the app's own `reseller_session` entirely inside `middleware.ts`, switched to Next.js's stable Node.js middleware runtime (`export const config = { runtime: 'nodejs' }`, confirmed available in the installed `next@15.5.19` build via `dist/build/entries.js`'s `pageRuntime === 'nodejs'` branch) rather than splitting the work across Edge middleware and a route handler. Node runtime middleware can call `better-sqlite3` and Node's `crypto` directly, so JWT/JWKS verification (via `jose`, Web-Crypto based) and the tenant lookup + session creation (via the existing `lib/tenantAuth.ts` primitives) happen in one pass, with no cookie hand-off between an Edge layer and a Node layer. The JWKS URL, issuer, and audience are pinned via server-side env config rather than trusted from the incoming `X-Authentik-Meta-Jwks` header, closing a bypass the requirements' own threat model (local header forgery direct to `127.0.0.1:3010`) would otherwise leave open.

Because `jose.jwtVerify` and `jose.createRemoteJWKSet` are Promise-based, `middleware.ts`'s exported `middleware()` function must become `async` (it is a plain synchronous function today). This is a named, load-bearing change — see Architecture and Integration points below, including its knock-on effect on the existing CSRF test file.

## Architecture

```
Browser --> Caddy (forward_auth authentik-server:9000, copy_headers
             extended: X-Authentik-Jwt, X-Authentik-Meta-Jwks, X-Authentik-Email,
             X-Authentik-Username, X-Authentik-Groups)
        --> Next.js app :3010, middleware.ts (Node.js runtime, `async function
             middleware(request): Promise<NextResponse>` -- changed from sync)
              1. CSRF origin-check (unchanged logic, now reached by a wider
                 matcher -- still only acts on mutating methods)
              2. Path exemption check (new): if the request path is one of
                 `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`,
                 `/login`, `/signup` -- skip straight to step 3's fall-through
                 (NextResponse.next()) without running the forward-auth branch
                 at all. CSRF (step 1) still applies to all of these; only the
                 identity check is skipped. Without this, a brand-new
                 Authentik-authenticated user with no existing tenant would
                 have their own `POST /api/auth/signup` (and the `/login`,
                 `/signup` page loads that render the forms) rejected by
                 step 3d before ever reaching the handler that would let them
                 sign up -- a permanent lockout with no way out, since the
                 `sso_error=unmatched` banner's own page load and the form's
                 own submit path go through the same blocked routes.
              3. Forward-auth-SSO check (new, skipped per step 2 above for the
                 exempted paths):
                 a. reseller_session cookie present & resolveSession() valid?
                      -> NextResponse.next() untouched (FR9, AC5)
                 b. X-Authentik-Jwt header absent?
                      -> NextResponse.next() untouched (FR10, AC2 -- local
                         dev / Tailscale-LAN paths never see this header)
                 c. JWT verification (jose.jwtVerify against a cached,
                    env-pinned JWKS, algorithms:[pinned], issuer/audience
                    pinned) fails (bad sig / expired / wrong iss-aud /
                    alg:none / alg-confusion)?
                      -> NextResponse.next() untouched -- request proceeds
                         exactly as an unauthenticated request would today
                         (existing page/route logic redirects to /login or
                         401s), never trusting the plaintext headers (FR1,
                         FR3, FR4, AC3)
                 d. Verified email claim checked as a non-empty string
                    (reject/treat-as-unverified if missing, empty, or not a
                    string) -> tenants lookup (COLLATE NOCASE).
                    Found -> createSession + setSessionCookie AND rewrite the
                    *current* request's own Cookie header (see below) so this
                    same request is seen as authenticated -- not just the
                    next one.
                    Not found -> distinct documented response, no session,
                    no auto-provision (FR8, AC4).
        --> Next.js page/route handlers (unchanged): read reseller_session
              cookie via resolveSession(), same as every existing protected
              page/route today.
```

**Same-request cookie visibility (step 3d).** Setting `Set-Cookie` on the
outgoing response only updates the browser's cookie jar for *future*
requests — it does not make the current request's own page component (which
reads cookies via `cookies()` / the incoming request object) see the new
session. Left as originally sketched, the very first SSO-authenticated
request would still get bounced by the page's own existing
"redirect if unauthenticated" check, contradicting AC1's literal claim that
*this* request succeeds with no redirect to `/api/auth/login`. Fix: use the
standard Next.js middleware pattern of rewriting the request's own `Cookie`
header before calling `NextResponse.next()`:

```ts
const requestHeaders = new Headers(request.headers);
requestHeaders.set('cookie', <existing-cookie-string-plus-new-reseller_session>);
const response = NextResponse.next({ request: { headers: requestHeaders } });
setSessionCookie(response, token, expiresAt); // Set-Cookie, for future requests too
```

This makes the *same* request pass through already-authenticated, while
`setSessionCookie` still attaches the `Set-Cookie` header so subsequent
requests carry the cookie without needing forward-auth to re-run.

JWKS fetching/caching (`jose.createRemoteJWKSet` against the single
env-pinned `AUTHENTIK_JWKS_URL` -- there is exactly one pinned URL for this
single-IdP, single-app deployment, so no keyed cache structure is needed; see
Integration points) is the only network call, and only happens on a cache
miss/cooldown expiry (FR11, AC8) -- never per-request.

## Data model

No data model changes.

`tenants.email` (`UNIQUE COLLATE NOCASE`, already present) is sufficient for the identity-to-tenant mapping; no new column or table is needed to satisfy FR6/FR8. Distinguishing a forward-auth-derived `tenant_sessions` row from a password-derived one is not required by any functional requirement or acceptance criterion -- both must behave identically (same TTL, same revocation, same cookie flags, per Out-of-scope's "no renegotiated TTL" and FR12), so `createSession()`'s signature is left unchanged and no `source`/`origin` column is added. This is a deliberate no-gold-plating call: if a future increment needs to distinguish session provenance (e.g. for an SLO/logout-propagation feature, explicitly out of scope here), that is a one-column additive migration at that time, not now. (Cross-referenced again in Risk areas, since it's also a reversibility tradeoff worth naming there.)

## API / interface contract

**New response contract for FR8 / AC4 (verified Authentik identity, no matching tenant):**

- Requests under `/api/*`: `403 { "error": "authentik_identity_unmatched" }`.
- All other (page) requests: `302` redirect to `/login?sso_error=unmatched`. `app/login/page.tsx` reads the `sso_error` query param and renders a distinct banner ("Your SSO login isn't linked to a reseller account yet. Log in with email/password below, or contact the operator.") above the existing form -- the existing password login path stays fully usable from the same page.

**Unchanged:** `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout` request/response shapes are untouched (AC6), and (per the new path-exemption step in Architecture) these are also never subject to the forward-auth identity check, only to the existing CSRF check. No new endpoint is added for forward-auth itself -- it is not a route the browser calls directly, only middleware behavior triggered by headers Caddy attaches.

**New env config (deployment-time, not request-time):**

- `AUTHENTIK_JWKS_URL` -- pinned JWKS endpoint, e.g. `https://authentik.internal:9000/application/o/<slug>/jwks/`. Source of truth for fetching keys; the incoming `X-Authentik-Meta-Jwks` header is never used to pick the fetch target (see Risk areas). Validated as an `https://` URL at module load, failing loudly (throwing) if it is `http://` or otherwise malformed -- an `http://` JWKS URL would open a downgrade/MITM path to a spoofed JWKS server.
- `AUTHENTIK_ISSUER` -- expected `iss` claim.
- `AUTHENTIK_AUDIENCE` -- expected `aud` claim (the Authentik proxy provider's client ID).
- All three unset in local dev / non-Authentik-fronted deployments; when unset, forward-auth verification is skipped entirely and step (b) above always takes the "header absent / feature not configured" path -- so a fresh checkout with no `.env` configured behaves exactly as it does today (additive-only, AC2).
- **All-or-nothing validation.** These three vars are checked once at module load (in `lib/forwardAuth.ts`): either all three are present and valid, or none are set at all. Any other combination (e.g. `AUTHENTIK_JWKS_URL` set but `AUTHENTIK_ISSUER` missing) throws loudly at startup rather than silently degrading into a partially-configured state at request time.

## Integration points

- `middleware.ts` -- switch to Node.js middleware runtime (`export const config = { runtime: 'nodejs', matcher: [...] }`); change the exported `middleware()` function from sync to **`async`** (required because `jose.jwtVerify`/`createRemoteJWKSet` are Promise-based -- see Approach/Architecture); widen the matcher from `/api/:path*` to everything except `_next/static`, `_next/image`, `favicon.ico`, **and the known static assets under `public/`** (`manifest.json`, `icon-192.png`, `icon-512.png`, `file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`, or an equivalent broader static-file-extension exclusion pattern) so icon/manifest fetches don't each pay a `better-sqlite3` `resolveSession()` round-trip; add the path-exemption check (`/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`, `/login`, `/signup` skip the forward-auth branch only, not the CSRF check); and restructure the single `middleware()` function into named helpers -- `checkCsrf(request)` (existing logic, unchanged behavior), `isForwardAuthExempt(pathname)` (new), and `applyForwardAuth(request)` (new, now async) -- called in that order, matching this repo's established pattern of extracting logic out of one function to keep fallow's complexity gate green (per the last two commits' BrandCombobox/VocabCombobox extractions).
- `lib/forwardAuth.ts` (new) -- a single lazily-initialized module-level JWKS set (`let jwksSet: ReturnType<typeof createRemoteJWKSet> | undefined`, initialized on first use from `AUTHENTIK_JWKS_URL`) -- **not** a `Map` keyed by URL; there is exactly one pinned URL for this single-IdP, single-app deployment, so a keyed cache structure is unnecessary complexity. Also: `verifyAuthentikJwt(jwt): Promise<{ email: string } | null>` (pins `algorithms`, `issuer`, `audience`; validates the resulting email claim is a non-empty string before returning it; returns `null` -- never throws to the caller, for *any* failure mode: network failure, timeout, malformed JWKS response, expired token, wrong claim, missing/empty/non-string email -- so `applyForwardAuth` has exactly one fail-closed branch to handle); an explicit `timeoutDuration` passed to `createRemoteJWKSet` (jose supports this option) rather than leaving the JWKS fetch on an implicit default timeout; the header-name constants (`X-Authentik-Jwt`, etc.); and the all-or-nothing env var validation described in API/interface contract above, run once at module load.
- `lib/tenantAuth.ts` -- add one small exported helper, `findTenantByEmail(email): string | null` (the same `SELECT id FROM tenants WHERE email = ? COLLATE NOCASE` query `verifyPassword` already runs, minus the password check) -- reused by `applyForwardAuth` for FR6's tenant lookup rather than duplicating the query inline in middleware.
- `app/login/page.tsx` -- read `sso_error` search param, render the distinct banner described above. The app has no existing `Suspense` boundary anywhere, and calling `useSearchParams()` directly in the top-level `'use client'` component is a known Next.js App Router issue (deopts the route to full client-side rendering, or fails the build, depending on version). Extract the `sso_error`-reading logic into a small inner client component and wrap *that* in `<Suspense>` within `app/login/page.tsx`, rather than calling `useSearchParams()` directly in the page's top-level component. No change to the existing form or `useAuthForm` submit flow.
- `next.config.ts` -- add as an integration point (previously missing from this list). The Risk areas section already flags that the Node.js middleware runtime's exact `config` export syntax "wasn't verified against a running build" -- resolve that before committing further implementation time: do a quick local `npm run build` spike against the actually-installed `next@15.5.19` to confirm the opt-in syntax, and update `next.config.ts` if the running build requires anything there (in addition to `middleware.ts`'s own `export const config`).
- `package.json` -- add `jose` as a dependency (see Technology choices).
- Deployment Caddyfile -- **not tracked in this repo** (lives on the deploy host per the existing houseoflight.dev deployment); its `forward_auth` block's `copy_headers` list must be extended from `X-Authentik-Username, X-Authentik-Groups` to also include `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, and `X-Authentik-Email`. This is a deployment prerequisite that has to land before/alongside this code change or forward-auth will silently no-op (falls through to path (b), "header absent") on the deployed instance -- it will not break anything, but it also won't do anything, so it's easy to mistake for "shipped but not working."
- `tests/e2e-deployed/authentik-auth.setup.ts` -- **flag, do not change in this increment.** Step 5 (a separate `/api/auth/signup` call after the real Authentik login) exists today because nothing wires the two together yet. Once forward-auth ships and the Caddyfile change lands, a real Authentik login for an account whose email already matches an existing tenant should auto-establish `reseller_session` without step 5 at all -- but step 5's throwaway-tenant-per-run pattern exists specifically because the QA harness account (`qa-harness-resale-inventory`) has no guaranteed matching tenant row, so removing step 5 outright would break the deployed suite under FR8's "no auto-provision" rule. Revisit this fixture (likely: pre-seed a tenant matching the QA harness's email, then delete step 5) as a follow-up once forward-auth is live in the deployed environment, not as part of this build.
- **`tests/api/tenant-isolation.test.ts` -- already exists today and already tests the CSRF middleware; must be updated, not created.** (Correcting a stale claim: this plan previously asserted no CSRF test file existed. It does.) It contains a `describe('AC15: CSRF middleware ...')` block with four call sites that call `middleware(req)` directly and synchronously, e.g. `const res = middleware(req); expect(res.status).toBe(403);`, plus two more asserting `.not.toBe(403)`. Once `middleware()` becomes `async` (per the change above), `res` becomes a `Promise<NextResponse>`, so `res.status` is `undefined`: the `.toBe(403)` assertions would fail loudly (safe), but the `.not.toBe(403)` assertions would pass *vacuously* (`undefined` is indeed not `403`), silently masking whether CSRF protection still works. Add `await` to all four `middleware(req)` call sites in this file as part of this change.
- `tests/api/forwardAuth.test.ts` (new, Vitest) -- unit coverage for `verifyAuthentikJwt` (valid token, expired, wrong issuer/audience, `alg:none`, algorithm-confusion attempt, malformed JWKS response, missing/empty/non-string email claim, JWKS fetch timeout) using `jose.createLocalJWKSet` / `jose.SignJWT` fixtures, and for `findTenantByEmail`.
- `tests/api/forwardAuthMiddleware.test.ts` or equivalent (new) -- the skip-if-valid-session path (FR9/AC5), the no-header pass-through path (FR10/AC2), the JWKS-not-refetched-per-request assertion (FR11/AC8, e.g. spy/count on the fetcher), the unmatched-tenant response shape (FR8/AC4), the path-exemption behavior for `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`, `/login`, `/signup`, and the same-request cookie-visibility behavior (a verified request's own downstream handler sees the new session without a second round-trip).
- `tests/e2e/` -- one new local Playwright spec exercising the full header-in -> cookie-out flow against a locally-run mock JWKS endpoint (a tiny `http.createServer` fixture, no live Authentik instance), satisfying the "mockable JWKS/JWT" NFR and AC10.
- `middleware.ts`'s existing CSRF test coverage (`tests/api/tenant-isolation.test.ts`, see above) -- rerun (with the `await` fixes) to confirm the wider matcher does not change CSRF's actual reject/allow outcomes (AC7); add one new case asserting a cross-origin mutating request is still rejected when Authentik headers are also present, to prove forward-auth can't be used as a CSRF side-channel.

## Technology choices

- **`jose`** for JWT/JWKS verification -- Web-Crypto-based (works identically whether middleware ends up Edge or Node, so this choice survives if the runtime decision is ever revisited), has first-class `createRemoteJWKSet` (with built-in fetch caching/cooldown, and a `timeoutDuration` option) and `createLocalJWKSet` (for fully offline unit tests) in one package, and forces explicit `algorithms`/`issuer`/`audience` options on every `jwtVerify` call -- there is no implicit "trust whatever `alg` the token claims" mode to accidentally leave enabled, which directly satisfies FR4's alg-pinning requirement. Chosen over `jsonwebtoken` + `jwks-rsa` (two packages, and `jsonwebtoken`'s API allows omitting `algorithms` and silently accepting the token's own `alg`).
- **Next.js Node.js middleware runtime** (stable in the installed `next@15.5.19`) -- the single most important call in this plan. It lets JWT verification and the DB-backed tenant lookup/session creation happen in the same request pass as the existing CSRF check, reusing `lib/tenantAuth.ts`'s Node-only primitives (`better-sqlite3`, `crypto.scryptSync`, `crypto.timingSafeEqual`) directly instead of building a second, Edge-safe session-resolution path or round-tripping through a route handler. The alternative (verify in Edge middleware, only touch the DB in a downstream handler) would require either a second cookie exchange or passing verified-identity state through a request-rewrite header trick -- more moving parts for no benefit on a single-instance, local-first app. Note this requires `middleware()` itself to become `async` (see Approach/Architecture/Integration points).
- **Env-pinned JWKS URL/issuer/audience** instead of trusting `X-Authentik-Meta-Jwks` (and the JWT's own `iss`/`aud`) at face value -- see Risk areas. Reuses the existing "config via env var" idiom already used for `BOOKSELLER_DB_PATH` etc. (`lib/db.ts`). `AUTHENTIK_JWKS_URL` is additionally required to be `https://` (see API/interface contract).

## Risk areas

- **Trusting the `X-Authentik-Meta-Jwks` header's URL would be circular.** The requirements text (FR2) says to verify against "the JWKS endpoint published in the `X-Authentik-Meta-Jwks` header," but the NFR's own threat model is a local process forging headers straight to `127.0.0.1:3010` -- if that header's URL is what gets fetched, an attacker who can forge headers can also forge a JWKS URL pointing at a key server they control, then sign a JWT with a matching key, and pass every other check (valid sig, matches a JWKS, non-`none` alg). This plan deliberately deviates from the literal reading and pins the JWKS URL via `AUTHENTIK_JWKS_URL` env config instead, treating the header as informational only. This is an interpretation call worth a second look before implementation starts, not an oversight.
- **Confirming the exact Node.js middleware opt-in syntax.** Verified via the shipped `dist/build/entries.js` (`pageRuntime === 'nodejs'` routes to the full server build) that the capability exists in the installed `next@15.5.19`, but the precise `config` export shape wasn't verified against a running build in this pass -- `tsc`/`next build` will fail loudly and immediately if it's wrong, so the blast radius of a wrong guess here is small, but budget a first-hour sanity check for it (see `next.config.ts` in Integration points -- a quick `npm run build` spike before committing further implementation time).
- **Middleware now runs on every page navigation, not just `/api/*`.** Broadening the matcher means `resolveSession()` (a SQLite read) can run twice per protected-page load -- once in middleware's skip-check, once again in the page component's own existing redirect check (e.g. `app/dashboard/page.tsx`). Acceptable for a single-instance local-first app per the NFR, but worth confirming there's no surprising interaction (e.g. WAL-mode lock contention) once it's actually running end-to-end.
- **Fallow's complexity/duplication gates.** This repo's last two commits were both dedicated to satisfying fallow after adding non-trivial branchy logic (`BrandCombobox`, `VocabCombobox`). `applyForwardAuth`'s branch count (exempt-path / skip / no-header / verify-fail / no-tenant / success) is very similar in shape to what tripped those gates before -- plan to extract sub-steps into `lib/forwardAuth.ts` helpers from the start rather than writing it as one flat function in `middleware.ts` and refactoring after a CI failure.
- **The deployed Caddyfile change is a hard external dependency this plan cannot verify from the repo.** If it's forgotten or mis-copied (wrong header name casing, etc.), the feature fails silently open into "header absent, behaves like today" rather than erroring -- good for safety, bad for noticing the miss. Worth a specific post-deploy smoke check (AC1's flow, run manually once against the real deployed instance) rather than assuming CI green implies the Caddyfile is correct.
- **Session-row growth from concurrent uncookied requests.** FR7 fires `createSession()` on every request that lacks a `reseller_session` cookie and carries a valid JWT, and a single Authentik login typically produces several concurrent, cookieless requests (the HTML document plus parallel asset/API fetches, all issued before the browser has applied the new `Set-Cookie`) -- each independently mints its own `tenant_sessions` row for the same login event. True request-level deduplication isn't practically achievable across stateless, concurrent HTTP requests without a cross-request mutex (and `resolveSession` can't recover a raw token from a stored hash to "reuse" an existing session for an as-yet-cookieless request). This row growth is an accepted, bounded characteristic for this increment -- bounded by the existing 7-day TTL as a natural ceiling, not by explicit dedup logic -- rather than a bug to solve here. `tenant_sessions` already has no GC job (per its own migration comment, already flagged as deferred/out of scope); when that GC job is eventually built, it needs to additionally account for this SSO-driven row-growth source, not just ordinary expiry.
- **No session-provenance column (password vs. SSO origin).** As noted in Data model, `createSession()` does not distinguish how a session was established. This means there is no way to selectively revoke "all SSO-derived sessions" without also revoking password-derived ones, should that ever be needed (e.g. as an incident response to an IdP compromise). Deliberate no-gold-plating call for this increment; revisit via an additive `source`/`origin` migration if that scenario arises.
- **App-level logout does not end the Authentik outpost session.** A user who logs out of the app (revoking their `reseller_session`) can be silently re-authenticated on their very next request, because Caddy's forward_auth will still present a valid `X-Authentik-Jwt` from their still-live Authentik session, and step 3d will mint a fresh session for them. This is intentionally out of scope per requirements.md (no SLO/logout-propagation in this increment), not an oversight -- named here explicitly so it isn't rediscovered as a "bug" later.
