import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

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

export function middleware(request: NextRequest): NextResponse {
  if (!MUTATING_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  const origin = request.headers.get('origin');

  // No Origin header: not a browser-driven cross-site request. Allow.
  if (origin === null) {
    return NextResponse.next();
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
    return NextResponse.next();
  }

  return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
}

export const config = {
  // Only guard the API surface; all mutating routes live under /api.
  matcher: ['/api/:path*'],
};
