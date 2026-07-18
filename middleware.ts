import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyAuthentikJwt } from '@/lib/forwardAuth';
import { findTenantByEmail, createSession, resolveSession, setSessionCookie } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';

// CSRF protection (plan.md Security -> "CSRF protection").
//
// Reject any mutating request whose Origin header does not match the app's own
// host. The real threat for a localhost-bound app with no auth is a malicious
// web page loaded in the operator's browser issuing cross-origin POSTs to the
// local server: the browser attaches an Origin header the attacker cannot forge
// or suppress, so a host mismatch is a reliable signal to reject.
//
// Requests with no Origin header (curl, server-to-server, same-origin GET) are
// not a browser cross-site vector, so they pass through. This check narrows the
// existing intent (plan.md already requires it and binds the server to
// localhost); it does not widen exposure.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function checkCsrf(request: NextRequest): NextResponse | null {
  if (!MUTATING_METHODS.has(request.method)) {
    return null;
  }

  const origin = request.headers.get('origin');

  // No Origin header: not a browser-driven cross-site request. Allow.
  if (origin === null) {
    return null;
  }

  const host = request.headers.get('host');

  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Malformed or opaque origin (e.g. the literal string "null" that browsers
    // send for sandboxed iframes / file:// pages). Treat as a mismatch.
    originHost = null;
  }

  if (host !== null && originHost !== null && originHost === host) {
    return null;
  }

  return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
}

// Forward-auth (Authentik) -- plan.md "Authentik forward-auth" / spec review
// fix for the new-tenant lockout bug (see the path-exemption comment below).
//
// Paths that must never be gated by forward-auth, even for a request that
// carries a verifiable Authentik identity with no matching tenant yet.
// Without this exemption, a brand-new Authentik-authenticated user who has
// never signed up as a tenant would have their *signup* request itself
// rejected by step 5 below (no tenant found -> 403/redirect) before it ever
// reached the signup handler -- a permanent lockout with no way to ever
// create a tenant. CSRF (checkCsrf, which already ran by the time this is
// called) still applies to these paths; only forward-auth is skipped.
const FORWARD_AUTH_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/login',
  '/signup',
]);

const AUTHENTIK_JWT_HEADER = 'x-authentik-jwt';

/**
 * Resolve tenant identity for this request from either an existing
 * reseller_session cookie or a verified Authentik forward-auth JWT, in that
 * order, and establish a session when a verified identity maps to a known
 * tenant. Returns the (possibly modified) response to send downstream.
 *
 * Order of checks matters:
 *   1. Path exemption (auth/signup/login/logout pages) -- see comment above.
 *   2. An already-valid reseller_session cookie short-circuits everything
 *      else: no need to re-verify a JWT when the tenant is already
 *      authenticated, and doing so would also mean redundantly minting a
 *      fresh session on every request.
 *   3. No X-Authentik-Jwt header at all -- this is the local-dev /
 *      Tailscale-LAN path that never goes through the Authentik proxy, so
 *      there's nothing to verify. Pass through untouched rather than
 *      forcing every non-forward-auth deployment through this code path.
 *   4. A present-but-invalid JWT (bad signature, expired, wrong iss/aud,
 *      wrong alg, JWKS fetch failure, missing email claim -- verifyAuthentikJwt
 *      collapses all of these to `null` by design) is treated as "no
 *      forward-auth identity" and passed through untouched. Crucially, the
 *      plaintext X-Authentik-Username / X-Authentik-Email / X-Authentik-Groups
 *      headers are never read or trusted here or anywhere downstream --
 *      only the JWT's verified `email` claim is used.
 *   5. A verified email resolves to a tenant or it doesn't. Found: establish
 *      a session (see the cookie-rewrite comment inline below for why both
 *      the outgoing response AND the current request need patching). Not
 *      found: reject -- 403 JSON for API paths, a redirect to a login page
 *      with an explanatory query param for page paths.
 */
async function applyForwardAuth(
  request: NextRequest,
  response: NextResponse,
): Promise<NextResponse> {
  if (FORWARD_AUTH_EXEMPT_PATHS.has(request.nextUrl.pathname)) {
    return response;
  }

  const existingSessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (existingSessionToken !== undefined && resolveSession(existingSessionToken) !== null) {
    return response;
  }

  const jwtHeader = request.headers.get(AUTHENTIK_JWT_HEADER);
  if (jwtHeader === null) {
    return response;
  }

  const verified = await verifyAuthentikJwt(jwtHeader);
  if (verified === null) {
    return response;
  }

  const tenantId = findTenantByEmail(verified.email);
  if (tenantId === null) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'authentik_identity_unmatched' }, { status: 403 });
    }
    // Explicit 302, not NextResponse.redirect's default 307 -- AC4 specifies
    // a 302 for the unmatched-identity redirect (this is a one-time,
    // non-idempotent-safe navigation away from the exempted paths, not a
    // "retry with the same method" case a 307 is meant for).
    const redirectUrl = new URL('/login?sso_error=unmatched', request.url);
    return NextResponse.redirect(redirectUrl, 302);
  }

  const { token, expiresAt } = createSession(tenantId);

  // Setting Set-Cookie on the outgoing response alone establishes the
  // session for *future* requests, but this current request's own
  // downstream page component reads cookies off the *incoming* request --
  // it would still see no session and could bounce to login, which would
  // violate "this exact request succeeds with no redirect". Fix: rebuild
  // the request's own Cookie header (preserving whatever cookies were
  // already on it) so the rest of this request's pipeline sees the new
  // session too, then attach Set-Cookie to that same rewritten response so
  // both fixes land on the one response object we return.
  const newRequestHeaders = new Headers(request.headers);
  const existingCookieHeader = newRequestHeaders.get('cookie');
  const newCookieValue =
    existingCookieHeader !== null && existingCookieHeader.length > 0
      ? `${existingCookieHeader}; ${SESSION_COOKIE_NAME}=${token}`
      : `${SESSION_COOKIE_NAME}=${token}`;
  newRequestHeaders.set('cookie', newCookieValue);

  const rewrittenResponse = NextResponse.next({ request: { headers: newRequestHeaders } });
  setSessionCookie(rewrittenResponse, token, expiresAt);
  return rewrittenResponse;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const csrfResponse = checkCsrf(request);
  if (csrfResponse !== null) {
    return csrfResponse;
  }

  return applyForwardAuth(request, NextResponse.next());
}

export const config = {
  // Node.js runtime opt-in: applyForwardAuth's verifyAuthentikJwt (jose's
  // jwtVerify) needs Node APIs the default Edge middleware runtime doesn't
  // support.
  runtime: 'nodejs',
  // Cover both the API surface and page navigations (applyForwardAuth gates
  // both), while excluding Next.js internals and known static assets under
  // public/ so those requests don't pay an auth round-trip.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-192.png|icon-512.png|file.svg|globe.svg|next.svg|vercel.svg|window.svg).*)',
  ],
};
