import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, type JWTVerifyResult, type JWTPayload } from 'jose';
import crypto from 'crypto';
import { createTestTenant } from '../helpers/tenant';
import { findTenantByEmail, createTenant } from '@/lib/tenantAuth';

// verifyAuthentikJwt() verifies HS256 tokens against a static, symmetric
// client_secret -- real, synchronous HMAC crypto over bytes already in hand,
// no network call and nothing to mock for the ordinary cases below. Every
// test in this file signs real tokens with jose's SignJWT and lets
// verifyAuthentikJwt run its real jwtVerify call against them.
//
// The one exception is the "unknown reason" test far below, which needs
// jose's jwtVerify to throw a value that isn't an Error instance -- something
// no real HS256 verification failure actually produces. That one test swaps
// in a throwing override via the hoisted box/vi.mock pattern; every other
// test in this file passes straight through to the real jose implementation
// (see the `impl` box's default below).
const jwtVerifyBox = vi.hoisted(() => ({
  impl: undefined as ((...args: unknown[]) => Promise<JWTVerifyResult<JWTPayload>>) | undefined,
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: vi.fn((...args: unknown[]) => {
      if (jwtVerifyBox.impl !== undefined) {
        return jwtVerifyBox.impl(...args);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.jwtVerify as any)(...args);
    }),
  };
});

const AUTHENTIK_CLIENT_SECRET = 'test-client-secret-hmac-key-do-not-use-in-prod';
const AUTHENTIK_ISSUER = 'https://authentik.example.com/application/o/resale/';
const AUTHENTIK_AUDIENCE = 'resale-inventory';
const HMAC_KEY = new TextEncoder().encode(AUTHENTIK_CLIENT_SECRET);
const WRONG_HMAC_KEY = new TextEncoder().encode('a-different-secret-the-app-does-not-have');

describe('verifyAuthentikJwt', () => {
  let validToken: string;
  let wrongSignatureToken: string;
  let noneAlgToken: string;
  let wrongAlgorithmToken: string;
  let wrongIssuerToken: string;
  let missingEmailToken: string;
  let emptyEmailToken: string;
  let numericEmailToken: string;
  let expiredToken: string;
  let wrongAudienceToken: string;

  const prevEnv = {
    AUTHENTIK_CLIENT_SECRET: process.env.AUTHENTIK_CLIENT_SECRET,
    AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
    AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
  };

  beforeAll(async () => {
    validToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(HMAC_KEY);

    // Signed with a secret the app doesn't have -- proves verification is
    // pinned to the real client_secret, not just "any well-formed HS256 JWT".
    wrongSignatureToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(WRONG_HMAC_KEY);

    // alg: none -- an unsigned token. Built by hand (jose's SignJWT refuses
    // to produce this) to prove verifyAuthentikJwt rejects it rather than
    // trusting an unsigned/"none"-algorithm assertion.
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const nonePayload = Buffer.from(
      JSON.stringify({
        email: 'reseller@example.com',
        iss: AUTHENTIK_ISSUER,
        aud: AUTHENTIK_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    noneAlgToken = `${noneHeader}.${nonePayload}.`;

    // A header claiming alg: RS256 -- proves algorithms: ['HS256'] pins the
    // accepted algorithm rather than trusting whatever the token's own
    // header claims. jose checks `alg` against the allowed-algorithms list
    // before it ever looks at the signature bytes (JOSEAlgNotAllowed fires
    // first), so the signature segment here doesn't need to be real -- only
    // structurally valid base64url.
    const rs256Header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
      'base64url',
    );
    const rs256Payload = Buffer.from(
      JSON.stringify({
        email: 'reseller@example.com',
        iss: AUTHENTIK_ISSUER,
        aud: AUTHENTIK_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    const fakeSignature = Buffer.from('not-a-real-signature').toString('base64url');
    wrongAlgorithmToken = `${rs256Header}.${rs256Payload}.${fakeSignature}`;

    wrongIssuerToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer('https://not-the-real-idp.example.com/')
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(HMAC_KEY);

    missingEmailToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(HMAC_KEY);

    emptyEmailToken = await new SignJWT({ email: '' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(HMAC_KEY);

    // JWT payloads are arbitrary JSON, not TypeScript-typed -- an `email`
    // claim shaped as a number (rather than absent or an empty string) is a
    // distinct case from missingEmailToken/emptyEmailToken above: it proves
    // verifyAuthentikJwt's `typeof email !== 'string'` check, not just the
    // `.length === 0` half of that condition.
    numericEmailToken = await new SignJWT({ email: 12345 })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(HMAC_KEY);

    const nowSeconds = Math.floor(Date.now() / 1000);
    expiredToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt(nowSeconds - 7200)
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime(nowSeconds - 3600)
      .sign(HMAC_KEY);

    wrongAudienceToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience('some-other-audience')
      .setExpirationTime('10m')
      .sign(HMAC_KEY);
  });

  afterAll(() => {
    process.env.AUTHENTIK_CLIENT_SECRET = prevEnv.AUTHENTIK_CLIENT_SECRET;
    process.env.AUTHENTIK_ISSUER = prevEnv.AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = prevEnv.AUTHENTIK_AUDIENCE;
    vi.resetModules();
  });

  describe('when forward-auth is configured', () => {
    // lib/forwardAuth.ts reads env + builds config at *module load* time, so
    // the env vars must be set and the module (re-)imported fresh, per the
    // pattern used in tests/api/tenant-isolation.test.ts (AC13).
    let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;

    beforeAll(async () => {
      process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
      process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
      process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
      vi.resetModules();
      ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
    });

    afterEach(() => {
      jwtVerifyBox.impl = undefined;
    });

    it('verifies a validly signed token and returns its email claim', async () => {
      const result = await verifyAuthentikJwt(validToken);
      expect(result).toEqual({ status: 'verified', email: 'reseller@example.com' });
    });

    it('rejects a token signed with the wrong secret (bad signature), reason invalid_signature, and still extracts kid/alg for logging', async () => {
      const result = await verifyAuthentikJwt(wrongSignatureToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_signature',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });

    it('rejects an unsigned alg:none token with reason invalid_algorithm', async () => {
      const result = await verifyAuthentikJwt(noneAlgToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm', alg: 'none' });
    });

    it('rejects a token whose header claims alg RS256 with reason invalid_algorithm, proving algorithms: ["HS256"] pins the accepted algorithm', async () => {
      const result = await verifyAuthentikJwt(wrongAlgorithmToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm', alg: 'RS256' });
    });

    it('rejects a token with the wrong issuer with reason invalid_issuer', async () => {
      const result = await verifyAuthentikJwt(wrongIssuerToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_issuer',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });

    it('rejects a validly signed token with no email claim with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(missingEmailToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'missing_email_claim',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });

    it('rejects a validly signed token with an empty-string email claim with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(emptyEmailToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'missing_email_claim' });
    });

    it('rejects a validly signed token whose email claim is a non-string (a number) with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(numericEmailToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'missing_email_claim' });
    });

    it('rejects a structurally invalid token string with reason malformed_token and no extractable kid/alg', async () => {
      const result = await verifyAuthentikJwt('not-a-jwt');
      expect(result).toEqual({
        status: 'invalid',
        reason: 'malformed_token',
        keyId: undefined,
        alg: undefined,
      });
    });

    it('rejects an expired token with reason token_expired', async () => {
      const result = await verifyAuthentikJwt(expiredToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'token_expired' });
    });

    it('rejects a token with the wrong audience with reason invalid_audience', async () => {
      const result = await verifyAuthentikJwt(wrongAudienceToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_audience' });
    });

    it('fails closed with reason unknown when a non-Error value is thrown (never crashes the request)', async () => {
      // Deliberately not an Error instance -- exercising classifyVerificationError's
      // final `unknown` fallback for a thrown value that isn't even `instanceof Error`.
      // Real HS256 verification never produces this itself; it's a defensive
      // path for whatever jose might throw that this module doesn't otherwise
      // classify.
      jwtVerifyBox.impl = () => {
        throw 'not an Error instance';
      };

      const result = await verifyAuthentikJwt(validToken);

      expect(result).toMatchObject({ status: 'invalid', reason: 'unknown' });
    });
  });

  describe('when forward-auth is not configured', () => {
    let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;

    beforeAll(async () => {
      delete process.env.AUTHENTIK_CLIENT_SECRET;
      delete process.env.AUTHENTIK_ISSUER;
      delete process.env.AUTHENTIK_AUDIENCE;
      vi.resetModules();
      ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
    });

    it('returns not_configured immediately without attempting verification', async () => {
      const result = await verifyAuthentikJwt(validToken);
      expect(result).toEqual({ status: 'not_configured' });
    });
  });
});

// Separate top-level describe: module-load-time configuration validation.
// lib/forwardAuth.ts throws (or doesn't) purely based on process.env at
// import time, before any JWT verification runs -- so each case here needs
// its own env snapshot/restore + vi.resetModules() + fresh dynamic import,
// same pattern as the "when forward-auth is (not) configured" blocks above.
//
// Unlike the earlier RS256/JWKS design, AUTHENTIK_CLIENT_SECRET is just an
// opaque string -- there's no URL to parse, no https://-required check, and
// no loopback-http test exception, since HS256 verification makes no network
// call at all. Only the all-or-nothing check below still applies.
describe('lib/forwardAuth.ts module-load configuration validation', () => {
  const prevEnv = {
    AUTHENTIK_CLIENT_SECRET: process.env.AUTHENTIK_CLIENT_SECRET,
    AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
    AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
  };

  afterEach(() => {
    process.env.AUTHENTIK_CLIENT_SECRET = prevEnv.AUTHENTIK_CLIENT_SECRET;
    process.env.AUTHENTIK_ISSUER = prevEnv.AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = prevEnv.AUTHENTIK_AUDIENCE;
    vi.resetModules();
  });

  it('throws at import time when exactly one of the three env vars is set', async () => {
    process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'Forward-auth env misconfigured: AUTHENTIK_CLIENT_SECRET, AUTHENTIK_ISSUER, and ' +
        'AUTHENTIK_AUDIENCE must be either all set or all unset (got 1/3 set). ' +
        'Partial config would silently disable or break JWT verification -- refusing to start.',
    );
  });

  it('throws at import time when exactly two of the three env vars are set', async () => {
    process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'Forward-auth env misconfigured: AUTHENTIK_CLIENT_SECRET, AUTHENTIK_ISSUER, and ' +
        'AUTHENTIK_AUDIENCE must be either all set or all unset (got 2/3 set). ' +
        'Partial config would silently disable or break JWT verification -- refusing to start.',
    );
  });

  it('does not throw at import time when all three env vars are set', async () => {
    process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).resolves.toBeDefined();
  });

  it('does not throw at import time when all three env vars are unset', async () => {
    delete process.env.AUTHENTIK_CLIENT_SECRET;
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).resolves.toBeDefined();
  });
});

// Separate top-level describe: findTenantByEmail() is plain DB lookup logic
// with no jose/JWT surface at all, so it doesn't need (and shouldn't share)
// the vi.mock('jose', ...) setup above. Runs against the real scratch test
// DB via lib/tenantAuth.ts's createTenant()/tests/helpers/tenant.ts's
// createTestTenant() -- no mocking.
describe('findTenantByEmail', () => {
  // Well past lib/tenantAuth.ts's MIN_PASSWORD_LENGTH floor; the value
  // itself is irrelevant here, only createTenant()'s email/id behavior is
  // under test.
  const TEST_PASSWORD = 'forward-auth-test-password';

  it('returns the tenant id for a matching email, case-insensitively', () => {
    const email = `forward-auth-${crypto.randomUUID()}@example.invalid`;
    const { tenantId } = createTenant(email, TEST_PASSWORD);

    const result = findTenantByEmail(email.toUpperCase());

    expect(result).toBe(tenantId);
  });

  it('returns null for a non-matching email', () => {
    // Seed a real, unrelated tenant first (via the shared test-tenant
    // helper) so this asserts "no match for this specific email", not
    // just "empty table returns null".
    createTestTenant();

    const result = findTenantByEmail(`no-such-tenant-${crypto.randomUUID()}@example.invalid`);

    expect(result).toBeNull();
  });
});
