# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 13 issues found, 11 accepted
- Scope & Dependency Auditor (sonnet): 10 issues found, 8 accepted
- Design Devil's Advocate (sonnet): 10 issues found, 9 accepted
- Implementation Realist (sonnet): 7 issues found, 6 accepted
- Steps & Sequencing Critic (sonnet): 18 issues found, 17 accepted
- Data Model Critic (sonnet): 1 issue found (no schema changes; query-pattern critique), 1 accepted (folded into a Risk-area note, not a schema change)
- Security/Threat Auditor (haiku): 11 issues found, 6 accepted

## Changes made
- **Fixed a permanent-lockout bug**: the widened middleware matcher combined with the "reject unmatched identity" rule would have blocked a brand-new Authentik-authenticated user's own `/api/auth/signup` and `/login`/`/signup` page loads before they ever reached the handler — with no path to ever create a tenant. Added an explicit path-exemption step so these routes skip only the forward-auth identity check (CSRF still applies).
- **Fixed a real, silent test regression**: `middleware()` must become `async` (JWT verification is Promise-based), but an already-existing test file, `tests/api/tenant-isolation.test.ts`, calls `middleware(req)` synchronously in 4 assertions inside a CSRF describe block — 2 would fail loudly, 2 would silently pass vacuously (`undefined !== 403`), masking whether CSRF protection still works. The original plan incorrectly claimed no such test file existed; corrected and added the required `await` fix as its own tracked change.
- **Fixed an AC1-violating correctness bug**: setting `Set-Cookie` on the middleware response only affects *future* browser requests — the *current* request's own page component would still see no session and bounce to `/login`, contradicting AC1's "no redirect" claim. Added the standard Next.js pattern of rewriting the request's own `Cookie` header via `NextResponse.next({ request: { headers } })` alongside the `Set-Cookie`, so the same request is treated as authenticated.
- Resolved every requirements-level `[TBD]` placeholder with concrete, testable values: `RS256` pinned algorithm, all-or-nothing env-var validation (fail loudly at startup on partial config), a behavioral (not numeric) JWKS caching requirement, and a concrete FR8/AC4 response contract (`403`/`{"error": "authentik_identity_unmatched"}` for API, `302` to `/login?sso_error=unmatched` for pages).
- Resolved the FR2-vs-plan contradiction: requirements now state the JWKS URL is pinned via server-side config (`AUTHENTIK_JWKS_URL`), and explicitly forbid using the request-supplied `X-Authentik-Meta-Jwks` header value as the fetch target (closes a header-forgery bypass the literal original requirement would have permitted).
- Flagged and fixed the Next.js App Router `useSearchParams()`-without-`Suspense` footgun in `app/login/page.tsx` (would otherwise fail the build or silently deopt the route to full client-side rendering).
- Split two oversized, weakly-tested steps (JWKS setup+verify+alg-pinning; mock-JWKS-fixture+E2E-scenarios) into properly-scoped sub-steps with real assertions instead of build/tsc-only checks; merged two under-sized/duplicate steps into their neighbors.
- Added missing test cases: forged plaintext headers with no JWT present (the literal NFR threat scenario), JWKS network failure/timeout (fail-closed), all-env-unset behavior, and partial-env-config startup failure.
- Simplified the JWKS cache from a `Map` keyed by URL to a single lazily-initialized module-level set — YAGNI, since this is a single-IdP, single-app deployment with exactly one pinned URL ever.

## Critiques rejected
- Security Auditor's "Tailscale-LAN vs Authentik traffic ambiguous at Caddy layer" — based on a misunderstanding; Tailscale/LAN access never traverses the houseoflight.dev Caddy block at all (separate network path), already correctly handled by the "no JWT header → pass through" branch.
- Security Auditor's "JWKS response size limit" and "secrets must come from a vault/secret-manager" — both are over-engineering for a single-operator, single-instance app already using plain env vars for other config (`BOOKSELLER_DB_PATH` etc.); the JWKS URL is env-pinned (not attacker-influenced), so a size-based DoS would require compromising the actual Authentik server, at which point there are much bigger problems.
- Scope Auditor's "`setSessionCookie` API mismatch between middleware and route handlers" — incorrect; `NextResponse.cookies.set()` is the same API in both contexts, no adaptation needed.
- Requirements Auditor's "FR9 'unrevoked' is vague" and "`findTenantByEmail` needs a requirements-level contract" — both already adequately grounded in existing code semantics (`resolveSession`'s documented revocation check) or are plan/implementation-level detail, not a requirements gap.
- Steps Critic's "Step 5's dependency on Step 4 is mislabeled" — technically true (same-file sequencing, not a hard logical dependency) but immaterial; left as-is since reordering would add churn for zero practical benefit within a single-worktree build.
- Design Devil's Advocate's push for a full Edge-vs-Node architecture reconsideration (verify JWT in Edge middleware, do DB work in a separate Node route) — the concern about the "one pass, no round-trip" justification is valid and now addressed directly (the cookie-header-rewrite fix removes the extra round-trip the critique was really pointing at), so the more invasive alternative wasn't adopted to avoid blowing up scope for a spec-challenge pass.

## Open questions requiring human input
- **The deployed Caddyfile change is a hard external dependency this repo cannot verify or apply.** Someone must extend the `forward_auth` block's `copy_headers` to include `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, and `X-Authentik-Email` on the actual deploy host — the feature will silently no-op (not error) until this lands. Tracked in `docs/AUTHENTIK-DEPLOYMENT.md` (Step 11) but requires a manual action outside this build.
- **Production values for `AUTHENTIK_ISSUER`/`AUTHENTIK_AUDIENCE` are not yet known** — these come from the real Authentik proxy-provider configuration on the deploy host and must be set as real env vars there; nothing in this repo can populate them.
- **Accepted, not solved: unbounded `tenant_sessions` row growth from concurrent uncookied requests during SSO login**, and **app-logout not ending the Authentik outpost session** (so app-logout is effectively undone by the next forward-auth request) — both are named, deliberate tradeoffs for this increment (see plan.md Risk areas), not fixed here. Worth a human decision on whether either needs solving in a follow-up increment.
