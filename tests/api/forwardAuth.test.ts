import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, type JWTVerifyResult, type JWTPayload } from 'jose';
import crypto from 'crypto';
import { createTestTenant } from '../fixtures/tenant';
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
  const realJwtVerify = actual.jwtVerify as (...args: unknown[]) => Promise<JWTVerifyResult<JWTPayload>>;
  return {
    ...actual,
    jwtVerify: vi.fn((...args: unknown[]) => {
      if (jwtVerifyBox.impl !== undefined) {
        return jwtVerifyBox.impl(...args);
      }
      return realJwtVerify(...args);
    }),
  };
});

const AUTHENTIK_CLIENT_SECRET = 'test-client-secret-hmac-key-do-not-use-in-prod';
const AUTHENTIK_ISSUER = 'https://authentik.example.com/application/o/resale/';
const AUTHENTIK_AUDIENCE = 'internal-inventory-app';
const HMAC_KEY = new TextEncoder().encode(AUTHENTIK_CLIENT_SECRET);
const WRONG_HMAC_KEY = new TextEncoder().encode('a-different-secret-the-app-does-not-have');
const RESELLER_CLAIMS = { email: 'reseller@example.com' };

const originalEnv = {
  AUTHENTIK_CLIENT_SECRET: process.env.AUTHENTIK_CLIENT_SECRET,
  AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
  AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
};

function restoreOriginalEnv() {
  process.env.AUTHENTIK_CLIENT_SECRET = originalEnv.AUTHENTIK_CLIENT_SECRET;
  process.env.AUTHENTIK_ISSUER = originalEnv.AUTHENTIK_ISSUER;
  process.env.AUTHENTIK_AUDIENCE = originalEnv.AUTHENTIK_AUDIENCE;
}

type TokenOptions = {
  issuer?: string;
  audience?: string;
  key?: Uint8Array;
  issuedAt?: number;
  expiresAt?: string | number;
};

function signToken(claims: JWTPayload, options: TokenOptions = {}) {
  const {
    issuer = AUTHENTIK_ISSUER,
    audience = AUTHENTIK_AUDIENCE,
    key = HMAC_KEY,
    issuedAt,
    expiresAt = '10m',
  } = options;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
    .setIssuedAt(issuedAt)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresAt)
    .sign(key);
}

// Built by hand because jose's SignJWT refuses to produce these headers.
// jose checks `alg` against the allowed list before it reads the signature,
// so the signature segment only needs to be valid base64url.
function handBuiltToken(alg: string, signature: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg, typ: 'JWT' });
  const payload = encode({
    ...RESELLER_CLAIMS,
    iss: AUTHENTIK_ISSUER,
    aud: AUTHENTIK_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  return `${header}.${payload}.${signature}`;
}

async function createTokens() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    valid: await signToken(RESELLER_CLAIMS),
    // Signed with a secret the app does not have: proves verification is
    // pinned to the real client_secret, not just "any well-formed HS256 JWT".
    wrongSignature: await signToken(RESELLER_CLAIMS, { key: WRONG_HMAC_KEY }),
    noneAlg: handBuiltToken('none', ''),
    // alg RS256 proves algorithms: ['HS256'] pins the accepted algorithm.
    wrongAlgorithm: handBuiltToken('RS256', Buffer.from('not-a-real-signature').toString('base64url')),
    wrongIssuer: await signToken(RESELLER_CLAIMS, { issuer: 'https://not-the-real-idp.example.com/' }),
    missingEmail: await signToken({}),
    emptyEmail: await signToken({ email: '' }),
    // A numeric email claim proves the `typeof email !== 'string'` check,
    // which is a different branch from the missing and empty cases.
    numericEmail: await signToken({ email: 12345 }),
    expired: await signToken(RESELLER_CLAIMS, { issuedAt: nowSeconds - 7200, expiresAt: nowSeconds - 3600 }),
    wrongAudience: await signToken(RESELLER_CLAIMS, { audience: 'some-other-audience' }),
  };
}

let tokens: Awaited<ReturnType<typeof createTokens>>;

async function createTokensOnce() {
  tokens = await createTokens();
}

// lib/forwardAuth.ts reads env and builds its config at module load, so each
// block sets the env, resets modules, and imports the module fresh (same
// pattern as tests/api/tenant-isolation.test.ts, AC13).
let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;

async function loadConfiguredForwardAuth() {
  process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
  process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
  process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
  vi.resetModules();
  ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
}

async function loadUnconfiguredForwardAuth() {
  delete process.env.AUTHENTIK_CLIENT_SECRET;
  delete process.env.AUTHENTIK_ISSUER;
  delete process.env.AUTHENTIK_AUDIENCE;
  vi.resetModules();
  ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
}

function clearJwtVerifyOverride() {
  jwtVerifyBox.impl = undefined;
}

function restoreEnvAndModules() {
  restoreOriginalEnv();
  vi.resetModules();
}

describe('verifyAuthentikJwt', () => {
  beforeAll(createTokensOnce);
  afterAll(restoreEnvAndModules);

  describe('when forward-auth is configured', () => {
    beforeAll(loadConfiguredForwardAuth);
    afterEach(clearJwtVerifyOverride);

    it('verifies a validly signed token and returns its email claim', async () => {
      const result = await verifyAuthentikJwt(tokens.valid);
      expect(result).toEqual({ status: 'verified', email: 'reseller@example.com' });
    });

    it('rejects a token signed with the wrong secret (bad signature), reason invalid_signature, and still extracts kid/alg for logging', async () => {
      const result = await verifyAuthentikJwt(tokens.wrongSignature);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_signature',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });

    it('rejects an unsigned alg:none token with reason invalid_algorithm', async () => {
      const result = await verifyAuthentikJwt(tokens.noneAlg);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm', alg: 'none' });
    });

    it('rejects a token whose header claims alg RS256 with reason invalid_algorithm, proving algorithms: ["HS256"] pins the accepted algorithm', async () => {
      const result = await verifyAuthentikJwt(tokens.wrongAlgorithm);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm', alg: 'RS256' });
    });

    it('rejects a token with the wrong issuer with reason invalid_issuer', async () => {
      const result = await verifyAuthentikJwt(tokens.wrongIssuer);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_issuer',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });
  });
});

describe('verifyAuthentikJwt', () => {
  beforeAll(createTokensOnce);
  afterAll(restoreEnvAndModules);

  describe('when forward-auth is configured', () => {
    beforeAll(loadConfiguredForwardAuth);
    afterEach(clearJwtVerifyOverride);

    it('rejects a validly signed token with no email claim with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(tokens.missingEmail);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'missing_email_claim',
        keyId: 'authentik-hs256',
        alg: 'HS256',
      });
    });

    it('rejects a validly signed token with an empty-string email claim with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(tokens.emptyEmail);
      expect(result).toMatchObject({ status: 'invalid', reason: 'missing_email_claim' });
    });

    it('rejects a validly signed token whose email claim is a non-string (a number) with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(tokens.numericEmail);
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
      const result = await verifyAuthentikJwt(tokens.expired);
      expect(result).toMatchObject({ status: 'invalid', reason: 'token_expired' });
    });
  });
});

describe('verifyAuthentikJwt', () => {
  beforeAll(createTokensOnce);
  afterAll(restoreEnvAndModules);

  describe('when forward-auth is configured', () => {
    beforeAll(loadConfiguredForwardAuth);
    afterEach(clearJwtVerifyOverride);

    it('rejects a token with the wrong audience with reason invalid_audience', async () => {
      const result = await verifyAuthentikJwt(tokens.wrongAudience);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_audience' });
    });

    it('fails closed with reason unknown when a non-Error value is thrown (never crashes the request)', async () => {
      // Deliberately not an Error instance -- exercising classifyVerificationError's
      // final `unknown` fallback for a thrown value that isn't even `instanceof Error`.
      // Real HS256 verification never produces this itself; it's a defensive
      // path for whatever jose might throw that this module doesn't otherwise
      // classify.
      const notAnError: unknown = 'not an Error instance';
      jwtVerifyBox.impl = () => {
        throw notAnError;
      };

      const result = await verifyAuthentikJwt(tokens.valid);

      expect(result).toMatchObject({ status: 'invalid', reason: 'unknown' });
    });
  });
});

describe('verifyAuthentikJwt', () => {
  beforeAll(createTokensOnce);
  afterAll(restoreEnvAndModules);

  describe('when forward-auth is not configured', () => {
    beforeAll(loadUnconfiguredForwardAuth);

    it('returns not_configured immediately without attempting verification', async () => {
      const result = await verifyAuthentikJwt(tokens.valid);
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
  afterEach(restoreEnvAndModules);

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
// DB via lib/tenantAuth.ts's createTenant()/tests/fixtures/tenant.ts's
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
