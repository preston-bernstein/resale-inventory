import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createTestTenant } from '../helpers/tenant';
import { createTenant } from '@/lib/tenantAuth';
import db from '@/lib/db';
import { SESSION_COOKIE_NAME } from '@/lib/constants';

// ---------------------------------------------------------------------------
// middleware.ts's applyForwardAuth() decision logic: path exemption, the
// existing-session short-circuit, header-presence handling, and response
// shaping. verifyAuthentikJwt (real JWT/JWKS crypto) is mocked directly --
// that crypto surface, plus jose's own createRemoteJWKSet caching, is
// tests/api/forwardAuth.test.ts's job, not this file's. Everything else
// (findTenantByEmail, createSession, resolveSession, setSessionCookie) is the
// real lib/tenantAuth.ts against the shared scratch test DB, same as
// tests/api/tenant-isolation.test.ts.
//
// vi.mock() factories are hoisted above this file's own top-level statements
// by vitest, so the mock below applies before @/middleware (imported further
// down, same as tests/api/tenant-isolation.test.ts) ever resolves its own
// '@/lib/forwardAuth' import. vi.hoisted() is required so the factory can
// close over a fn reference this file also asserts against.
// ---------------------------------------------------------------------------

const { verifyAuthentikJwtMock } = vi.hoisted(() => ({
  verifyAuthentikJwtMock: vi.fn<() => Promise<{ email: string } | null>>(),
}));

vi.mock('@/lib/forwardAuth', () => ({
  verifyAuthentikJwt: verifyAuthentikJwtMock,
}));

import { middleware } from '@/middleware';

const JWT_HEADER = 'X-Authentik-Jwt';
const TEST_PASSWORD = 'forward-auth-middleware-test-pw';

function sessionCount(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM tenant_sessions').get() as { c: number }).c;
}

beforeEach(() => {
  verifyAuthentikJwtMock.mockReset();
});

describe('FR9/AC5: an existing valid session short-circuits forward-auth entirely', () => {
  it('is not re-verified against any JWT, creates no duplicate session, and passes through untouched even with Authentik headers present', async () => {
    const tenant = createTestTenant();
    const before = sessionCount();

    const req = new NextRequest('http://localhost/api/items', {
      headers: {
        Cookie: tenant.cookieHeader,
        [JWT_HEADER]: 'a-jwt-that-must-never-be-checked',
        'X-Authentik-Username': 'someone-else',
        'X-Authentik-Email': 'someone-else@example.com',
      },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(sessionCount()).toBe(before);
    expect(res.status).toBe(200);
    // NextResponse.next()'s internal marker for "pass through unchanged" --
    // confirms this isn't the rewritten-cookie response path.
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('FR10/AC2: no X-Authentik-Jwt header passes through exactly as if forward-auth did not exist', () => {
  it('a request with no forward-auth header and no session cookie is never handed to verifyAuthentikJwt', async () => {
    const req = new NextRequest('http://localhost/api/items');

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('NFR threat scenario: forged plaintext Authentik headers without a JWT are inert', () => {
  it('X-Authentik-Username/Email/Groups headers alone, with no X-Authentik-Jwt, never establish a session', async () => {
    const before = sessionCount();

    const req = new NextRequest('http://localhost/api/items', {
      headers: {
        'X-Authentik-Username': 'attacker',
        'X-Authentik-Email': 'attacker@example.com',
        'X-Authentik-Groups': 'admin,superuser',
      },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(sessionCount()).toBe(before);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('Path exemption (the lockout-bug fix): exempt paths never get rejected for an unmatched tenant', () => {
  it('POST /api/auth/signup with a verified JWT but no matching tenant passes through instead of 403ing', async () => {
    verifyAuthentikJwtMock.mockResolvedValue({
      email: `no-tenant-${crypto.randomUUID()}@example.invalid`,
    });

    const req = new NextRequest('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    // The exempt-path check is the very first thing applyForwardAuth does --
    // it returns before ever looking at the session cookie or the JWT
    // header, so verification is never even attempted here.
    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('GET /login with a verified JWT but no matching tenant passes through instead of redirecting', async () => {
    const req = new NextRequest('http://localhost/login', {
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('GET /signup with a verified JWT but no matching tenant passes through instead of redirecting', async () => {
    const req = new NextRequest('http://localhost/signup', {
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/login with a verified JWT but no matching tenant passes through instead of 403ing', async () => {
    const req = new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/logout with a verified JWT but no matching tenant passes through instead of 403ing', async () => {
    const req = new NextRequest('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe('FR1/FR3/FR4/AC3: an invalid JWT is treated exactly like no JWT at all', () => {
  it('a present X-Authentik-Jwt that fails verification (mock resolves null) passes through untouched, same as no header', async () => {
    verifyAuthentikJwtMock.mockResolvedValue(null);
    const before = sessionCount();

    const req = new NextRequest('http://localhost/api/items', {
      headers: { [JWT_HEADER]: 'this-fails-verification' },
    });

    const res = await middleware(req);

    expect(verifyAuthentikJwtMock).toHaveBeenCalledWith('this-fails-verification');
    expect(sessionCount()).toBe(before);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('An expired/invalid reseller_session cookie does not short-circuit -- forward-auth still runs', () => {
  it('a garbage session cookie value falls through to check the JWT header instead of trusting the cookie', async () => {
    const email = `stale-cookie-${crypto.randomUUID()}@example.invalid`;
    createTenant(email, TEST_PASSWORD);
    verifyAuthentikJwtMock.mockResolvedValue({ email });

    const req = new NextRequest('http://localhost/dashboard', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=not-a-real-session-token`,
        [JWT_HEADER]: 'verified-jwt',
      },
    });

    const res = await middleware(req);

    // resolveSession() rejects the garbage token, so the existing-session
    // short-circuit does NOT apply -- verifyAuthentikJwt gets called, unlike
    // the FR9/AC5 test above where a genuinely valid cookie skips it.
    expect(verifyAuthentikJwtMock).toHaveBeenCalled();
    expect(res.status).not.toBe(403);
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
  });
});

describe('FR8/AC4: unmatched-tenant response shape on non-exempt paths', () => {
  it('returns 403 {"error": "authentik_identity_unmatched"} for an /api/* path', async () => {
    const email = `unmatched-api-${crypto.randomUUID()}@example.invalid`;
    verifyAuthentikJwtMock.mockResolvedValue({ email });

    const req = new NextRequest('http://localhost/api/items', {
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'authentik_identity_unmatched' });
  });

  it('redirects to /login?sso_error=unmatched for a page path', async () => {
    const email = `unmatched-page-${crypto.randomUUID()}@example.invalid`;
    verifyAuthentikJwtMock.mockResolvedValue({ email });

    const req = new NextRequest('http://localhost/dashboard', {
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(res.headers.get('location')).toBe('http://localhost/login?sso_error=unmatched');
    // FR8/AC4 specifies 302 -- middleware.ts passes it explicitly to
    // NextResponse.redirect (rather than relying on the 307 default).
    expect(res.status).toBe(302);
  });
});

describe('AC1: successful session establishment', () => {
  it('a verified JWT matching an existing tenant results in a reseller_session cookie on the response', async () => {
    const email = `matched-${crypto.randomUUID()}@example.invalid`;
    createTenant(email, TEST_PASSWORD);
    verifyAuthentikJwtMock.mockResolvedValue({ email });

    const req = new NextRequest('http://localhost/dashboard', {
      headers: { [JWT_HEADER]: 'verified-jwt' },
    });

    const res = await middleware(req);

    expect(res.status).not.toBe(403);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(res.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
  });

  it('preserves an unrelated pre-existing cookie on the request when rewriting in the new reseller_session cookie', async () => {
    const email = `matched-with-other-cookie-${crypto.randomUUID()}@example.invalid`;
    createTenant(email, TEST_PASSWORD);
    verifyAuthentikJwtMock.mockResolvedValue({ email });

    const req = new NextRequest('http://localhost/dashboard', {
      headers: {
        Cookie: 'unrelated_cookie=some-value',
        [JWT_HEADER]: 'verified-jwt',
      },
    });

    const res = await middleware(req);

    // The rewritten *request* (not the response) is what downstream page
    // components read -- NextResponse.next()'s request-header rewrite is
    // reflected back on x-middleware-request-* headers in the test
    // environment, so assert on the actual mechanism: the outgoing
    // Set-Cookie is additive, not a wholesale replacement of the cookie jar.
    const requestCookieHeader = res.headers.get('x-middleware-request-cookie');
    expect(requestCookieHeader).toContain('unrelated_cookie=some-value');
    expect(requestCookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
  });
});

describe('AC7: CSRF interaction -- Authentik headers must not be usable as a CSRF bypass', () => {
  it('a cross-origin mutating request with Authentik headers present is still rejected by the CSRF check', async () => {
    verifyAuthentikJwtMock.mockResolvedValue({
      email: `csrf-bypass-attempt-${crypto.randomUUID()}@example.invalid`,
    });

    const req = new NextRequest('http://localhost/api/items', {
      method: 'POST',
      headers: {
        origin: 'http://evil.example.com',
        host: 'localhost:3000',
        [JWT_HEADER]: 'verified-jwt',
        'X-Authentik-Username': 'attacker',
        'X-Authentik-Email': 'attacker@example.com',
      },
    });

    const res = await middleware(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Origin not allowed.');
    // CSRF is checked before applyForwardAuth runs at all -- forward-auth
    // headers never even get a chance to be evaluated.
    expect(verifyAuthentikJwtMock).not.toHaveBeenCalled();
  });
});
