import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';
import { GET as connectionsGET } from '@/app/api/connections/route';
import { SCRYPT_PARAMS, MIN_PASSWORD_LENGTH } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';
import { resetRateLimitsForTests } from '@/lib/rateLimit';
import { createTestTenant } from '../helpers/tenant';

// Every test below shares this file's module registry, and therefore
// lib/rateLimit.ts's in-memory bucket state (see that module's comments).
// Reset before each test so no test's signup/login call count can push a
// LATER, unrelated test over a rate-limit threshold -- only the dedicated
// "rate limiting" describe block below deliberately drives a key to its
// limit.
beforeEach(() => {
  resetRateLimitsForTests();
});

// ---------------------------------------------------------------------------
// Acceptance tests for AC1 (401 on missing tenant identity) plus the
// signup/login/logout flows that everything else in this suite depends on.
// See docs/reseller-multi-tenant-foundation/requirements.md's Acceptance
// criteria section and plan.md's Auth API contract.
// ---------------------------------------------------------------------------

function jsonRequest(url: string, body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function signupRequest(body: unknown) {
  return jsonRequest('http://localhost/api/auth/signup', body);
}

function loginRequest(body: unknown) {
  return jsonRequest('http://localhost/api/auth/login', body);
}

function logoutRequest(cookie?: string) {
  return new NextRequest('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function tenantScopedRequest(cookie?: string) {
  return new NextRequest('http://localhost/api/connections', {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

describe('POST /api/auth/signup', () => {
  it('creates a tenant and issues an httpOnly session cookie, 201 with tenant_id', async () => {
    const email = `signup-${crypto.randomUUID()}@example.invalid`;
    const res = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenant_id).toBeTruthy();

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('sets the session cookie with SameSite=Lax and Path=/, not just httpOnly', async () => {
    const email = `signup-attrs-${crypto.randomUUID()}@example.invalid`;
    const res = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('a non-constraint DB error during signup propagates instead of being reported as a 409 duplicate', async () => {
    const db = (await import('@/lib/db')).default;
    const originalPrepare = db.prepare.bind(db);
    const dbError = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO tenants')) {
        return { run: () => { throw dbError; } } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    const email = `dberr-route-${crypto.randomUUID()}@example.invalid`;
    await expect(
      signupPOST(signupRequest({ email, password: 'a-strong-enough-password' })),
    ).rejects.toThrow('database is locked');

    spy.mockRestore();
  });

  it('rejects a duplicate email with 409', async () => {
    const email = `dup-${crypto.randomUUID()}@example.invalid`;
    const first = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
    expect(first.status).toBe(201);

    const second = await signupPOST(signupRequest({ email, password: 'a-different-password' }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe('Email already registered.');
  });

  it('rejects a duplicate email that differs only in case (COLLATE NOCASE uniqueness)', async () => {
    const email = `case-${crypto.randomUUID()}@example.invalid`;
    const first = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
    expect(first.status).toBe(201);

    const second = await signupPOST(
      signupRequest({ email: email.toUpperCase(), password: 'a-different-password' }),
    );
    expect(second.status).toBe(409);
  });

  it('rejects a password shorter than the minimum length, 422', async () => {
    const email = `weak-${crypto.randomUUID()}@example.invalid`;
    const res = await signupPOST(signupRequest({ email, password: 'short' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('password');
  });

  it('rejects a missing email, 422', async () => {
    const res = await signupPOST(signupRequest({ password: 'a-strong-enough-password' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('email');
  });

  it('rejects malformed JSON, 400', async () => {
    const req = new NextRequest('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    const res = await signupPOST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('valid credentials succeed: 200, tenant_id, session cookie set', async () => {
    const email = `login-${crypto.randomUUID()}@example.invalid`;
    const password = 'a-strong-enough-password';
    const signupRes = await signupPOST(signupRequest({ email, password }));
    const signupBody = await signupRes.json();

    const res = await loginPOST(loginRequest({ email, password }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant_id).toBe(signupBody.tenant_id);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('wrong password returns the same generic 401 as a nonexistent email (no user enumeration)', async () => {
    const email = `wrongpw-${crypto.randomUUID()}@example.invalid`;
    await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));

    const wrongPasswordRes = await loginPOST(loginRequest({ email, password: 'totally-wrong' }));
    const nonexistentRes = await loginPOST(
      loginRequest({ email: `nosuchuser-${crypto.randomUUID()}@example.invalid`, password: 'whatever12345' }),
    );

    expect(wrongPasswordRes.status).toBe(401);
    expect(nonexistentRes.status).toBe(401);
    const wrongBody = await wrongPasswordRes.json();
    const nonexistentBody = await nonexistentRes.json();
    expect(wrongBody.error).toBe(nonexistentBody.error);
  });

  it('a login response never contains the submitted password string anywhere in its body', async () => {
    const email = `nocreds-${crypto.randomUUID()}@example.invalid`;
    const password = 'super-secret-password-value';
    await signupPOST(signupRequest({ email, password }));

    const res = await loginPOST(loginRequest({ email, password }));
    const text = await res.text();
    expect(text).not.toContain(password);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie, 204; the old cookie is rejected afterward (AC1)', async () => {
    const tenant = createTestTenant();

    // Confirm the session works before logout.
    const before = await connectionsGET(tenantScopedRequest(tenant.cookieHeader));
    expect(before.status).toBe(200);

    const res = await logoutPOST(logoutRequest(tenant.cookieHeader));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    // Not just the value change -- the clearing cookie must carry the same
    // httpOnly/sameSite/path flags as the original, plus Max-Age=0, or the
    // browser won't recognize it as overwriting/expiring the real cookie.
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=0');

    // AC1: the now-revoked session no longer resolves to a tenant identity.
    const after = await connectionsGET(tenantScopedRequest(tenant.cookieHeader));
    expect(after.status).toBe(401);
  });

  it('is idempotent: logging out with no cookie at all still returns 204', async () => {
    const res = await logoutPOST(logoutRequest());
    expect(res.status).toBe(204);
  });
});

describe('AC1: tenant-scoped routes reject requests with no resolvable tenant identity', () => {
  it('returns 401, not the data, when no session cookie is present', async () => {
    const res = await connectionsGET(tenantScopedRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).not.toHaveProperty('id');
  });

  it('returns 401 for a well-formed but unknown session token', async () => {
    const fakeToken = 'a'.repeat(64); // correct hex length, never issued
    const res = await connectionsGET(tenantScopedRequest(`${SESSION_COOKIE_NAME}=${fakeToken}`));
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed (wrong-length) cookie value', async () => {
    const res = await connectionsGET(tenantScopedRequest(`${SESSION_COOKIE_NAME}=not-a-real-token`));
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const tenant = createTestTenant();
    // Force this tenant's most recent session row into the past.
    const db = (await import('@/lib/db')).default;
    db.prepare(
      'UPDATE tenant_sessions SET created_at = ?, expires_at = ? WHERE tenant_id = ?',
    ).run(Date.now() - 10_000, Date.now() - 1000, tenant.tenantId);

    const res = await connectionsGET(tenantScopedRequest(tenant.cookieHeader));
    expect(res.status).toBe(401);
  });
});

describe('scrypt cost parameters meet the OWASP baseline floor', () => {
  it('N >= 16384, r = 8, p >= 1', () => {
    expect(SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(16384);
    expect(SCRYPT_PARAMS.r).toBe(8);
    expect(SCRYPT_PARAMS.p).toBeGreaterThanOrEqual(1);
  });

  it('MIN_PASSWORD_LENGTH enforces a real floor, not zero', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});

describe('auth endpoints apply basic rate limiting (NFR)', () => {
  it('login: returns 429 once the per-account attempt limit is exceeded, before touching verifyPassword', async () => {
    const email = `ratelimit-login-${crypto.randomUUID()}@example.invalid`;
    await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));

    // Drive the same (ip, email) key to its limit with wrong passwords --
    // every one of these still 401s (limit not yet reached).
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await loginPOST(loginRequest({ email, password: 'still-wrong' }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(401);

    // The next attempt against the same account crosses the limit -> 429,
    // even though the credentials are irrelevant at this point.
    const limited = await loginPOST(loginRequest({ email, password: 'still-wrong' }));
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error).toMatch(/too many/i);
  });

  it('login: a correct password is also rejected with 429 once the account is rate-limited', async () => {
    const email = `ratelimit-login-ok-${crypto.randomUUID()}@example.invalid`;
    const password = 'a-strong-enough-password';
    await signupPOST(signupRequest({ email, password }));

    for (let i = 0; i < 10; i++) {
      await loginPOST(loginRequest({ email, password: 'still-wrong' }));
    }

    // Even the RIGHT password is blocked once the account-level limit is
    // hit -- the rate limit is checked before verifyPassword() runs at all.
    const res = await loginPOST(loginRequest({ email, password }));
    expect(res.status).toBe(429);
  });

  it('signup: returns 429 once the per-IP limit is exceeded', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 20; i++) {
      const email = `ratelimit-signup-${crypto.randomUUID()}@example.invalid`;
      const res = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(201);

    const email = `ratelimit-signup-over-${crypto.randomUUID()}@example.invalid`;
    const limited = await signupPOST(signupRequest({ email, password: 'a-strong-enough-password' }));
    expect(limited.status).toBe(429);
  });
});
