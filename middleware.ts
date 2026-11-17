import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { verifyAuthentikJwt, type ForwardAuthFailureReason } from '@/lib/forwardAuth';
import { findTenantByEmail, createSession, resolveSession, setSessionCookie } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import { logEvent } from '@/lib/log';
import { recordForwardAuthOutcome } from '@/lib/metrics';

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

// Failure reasons that mean "the verifier itself could not classify the
// failure" versus reasons that mean "this specific credential was
// rejected." Per CONVENTIONS.md #18's level discipline ("warn is for a
// condition the service already handled... error is for a unit of work that
// did not complete"): a single bad/expired/malformed token is a normal,
// fully-handled condition (the request is correctly denied, no service
// dependency broke), so it logs at `warn`. `unknown` (an error jose didn't
// classify, or a non-Error thrown value) is `error`: it is by definition not
// one of the classified, expected-and-handled cases. HS256 verification
// (see lib/forwardAuth.ts) makes no network call, so there is no longer a
// verifier-dependency-down failure mode distinct from "unknown".
const FORWARD_AUTH_ERROR_LEVEL_REASONS = new Set<ForwardAuthFailureReason>(['unknown']);

/**
 * Build the response for a JWT that was PRESENTED but could not be verified.
 * Deliberately uniform across every ForwardAuthFailureReason -- the reason is
 * logged and counted server-side (see applyForwardAuth) but never reflected
 * in the response body/status, so a client (or an attacker probing this
 * endpoint) cannot use response shape to fingerprint verifier internals
 * (e.g. distinguish "your token expired" from "the JWKS endpoint is down").
 * Mirrors the existing unmatched-tenant response shape (403 JSON for /api/*,
 * a 302 redirect with a distinct sso_error for page routes) so the app's
 * error-response surface stays consistent.
 */
function forwardAuthVerificationFailedResponse(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'authentik_verification_failed' }, { status: 401 });
  }
  const redirectUrl = new URL('/login?sso_error=verification_failed', request.url);
  return NextResponse.redirect(redirectUrl, 302);
}

type InvalidJwt = Extract<Awaited<ReturnType<typeof verifyAuthentikJwt>>, { status: 'invalid' }>;

/**
 * Deny a JWT that failed verification. A credential was presented and not
 * confirmed, which differs from "no credential", so the request fails closed
 * (see the 2026-08-01 security fix note on verifyAuthentikJwt). The reason is
 * logged and counted so a run of `jwks_unreachable` or `key_not_found`, which
 * means the verifier's own dependency is broken, stays visible.
 */
function rejectInvalidJwt(request: NextRequest, verified: InvalidJwt): NextResponse {
  const runId = uuidv4();
  const level = FORWARD_AUTH_ERROR_LEVEL_REASONS.has(verified.reason) ? 'error' : 'warn';
  logEvent(level, 'forward_auth.verification_failed', 'Authentik JWT verification failed', {
    run_id: runId,
    path: request.nextUrl.pathname,
    outcome: 'failed',
    reason: verified.reason,
    key_id: verified.keyId,
    alg: verified.alg,
  });
  void recordForwardAuthOutcome(verified.reason);
  return forwardAuthVerificationFailedResponse(request);
}

function rejectUnmatchedIdentity(request: NextRequest): NextResponse {
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

function establishSession(request: NextRequest, tenantId: string): NextResponse {
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

/**
 * Resolve tenant identity from a reseller_session cookie or a verified
 * Authentik JWT, in that order, and establish a session for a known tenant.
 * Checks run in a fixed order: exempt paths, a valid session cookie, no JWT
 * header (pass through), a JWT that fails verification (deny), then the
 * tenant lookup. Only the verified `email` claim is trusted, never the
 * plaintext X-Authentik-* headers.
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

  if (verified.status === 'not_configured') {
    // Forward-auth isn't enabled for this deployment at all (all three
    // AUTHENTIK_* env vars unset). A JWT header showing up here at all would
    // be unexpected (no Caddy forward_auth block should be attaching it),
    // but there is nothing to verify against either way -- treat exactly
    // like the header-absent case above: not a failure, not logged, not
    // counted.
    return response;
  }

  if (verified.status === 'invalid') {
    return rejectInvalidJwt(request, verified);
  }

  void recordForwardAuthOutcome('verified');

  const tenantId = findTenantByEmail(verified.email);
  if (tenantId === null) {
    return rejectUnmatchedIdentity(request);
  }

  return establishSession(request, tenantId);
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
