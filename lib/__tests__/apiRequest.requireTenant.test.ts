import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '../apiRequest';
import { resolveSession, revokeSession } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import db from '@/lib/db';
import { createTestTenant } from '../../tests/helpers/tenant';

// Throwaway coverage for Task 5 (lib/apiRequest.ts :: requireTenant). Kept
// alongside the file it tests, separate from lib/__tests__/apiRequest.test.ts
// so parseItemId's existing test file is untouched.

function requestWithCookie(cookieHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });
}

describe('lib/apiRequest.ts requireTenant', () => {
  it('returns a 401 NextResponse when no session cookie is present', () => {
    const result = requireTenant(requestWithCookie());
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('resolves to the correct tenantId for a valid session cookie', () => {
    const tenant = createTestTenant();
    const result = requireTenant(requestWithCookie(tenant.cookieHeader));
    expect(result).toEqual({ tenantId: tenant.tenantId });
  });

  it('returns a 401 NextResponse for a garbage/malformed cookie value', () => {
    const result = requireTenant(requestWithCookie(`${SESSION_COOKIE_NAME}=not-a-valid-token`));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('returns a 401 NextResponse for an expired session', async () => {
    const tenant = createTestTenant();
    // Confirm the session is live before manually expiring it, so the test
    // actually exercises the expiry branch rather than an already-broken
    // session token.
    expect(resolveSession(tenant.token)).not.toBeNull();

    // tenant_sessions has a CHECK (expires_at > created_at) constraint, so
    // expires_at can't be backdated before creation -- instead, set it to
    // created_at + 1ms and wait past that point, which still lands squarely
    // in the "expired" branch (Date.now() > row.expires_at) once the wait
    // resolves.
    const tokenHash = crypto.createHash('sha256').update(tenant.token, 'utf8').digest('hex');
    const row = db
      .prepare('SELECT created_at FROM tenant_sessions WHERE session_token_hash = ?')
      .get(tokenHash) as { created_at: number };
    db.prepare('UPDATE tenant_sessions SET expires_at = ? WHERE session_token_hash = ?').run(
      row.created_at + 1,
      tokenHash,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = requireTenant(requestWithCookie(tenant.cookieHeader));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('returns a 401 NextResponse for a revoked session', () => {
    const tenant = createTestTenant();
    expect(resolveSession(tenant.token)).not.toBeNull();

    revokeSession(tenant.token);

    const result = requireTenant(requestWithCookie(tenant.cookieHeader));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });
});
