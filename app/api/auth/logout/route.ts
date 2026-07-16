import { NextRequest, NextResponse } from 'next/server';
import { revokeSession, clearSessionCookie } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';

// ---------------------------------------------------------------------------
// POST /api/auth/logout — revoke the session (if any), clear the cookie.
//
// Idempotent by construction: lib/tenantAuth.ts's revokeSession() is a
// no-op for an already-revoked, expired, unknown, or malformed token, and
// clearSessionCookie() unconditionally overwrites/expires the cookie. A
// request with no cookie at all just clears nothing and returns 204.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (cookie) {
    revokeSession(cookie.value);
  }

  const response = new NextResponse(null, { status: 204 });
  clearSessionCookie(response);
  return response;
}
