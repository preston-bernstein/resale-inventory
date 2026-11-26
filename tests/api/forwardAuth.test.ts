import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, type JWTVerifyResult, type JWTPayload } from 'jose';
import crypto from 'crypto';
import { createTestTenant } from '../tenantFixtures';
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
      return Reflect.apply(actual.jwtVerify, undefined, args) as Promise<JWTVerifyResult<JWTPayload>>;
    }),
  };
});

const AUTHENTIK_CLIENT_SECRET = 'test-client-secret-hmac-key-do-not-use-in-prod';
const AUTHENTIK_ISSUER = 'https://authentik.example.com/application/o/resale/';
const AUTHENTIK_AUDIENCE = 'internal-inventory-app';
const HMAC_KEY = new TextEncoder().encode(AUTHENTIK_CLIENT_SECRET);
const WRONG_HMAC_KEY = new TextEncoder().encode('a-different-secret-the-app-does-not-have');

const PREV_ENV = {
  AUTHENTIK_CLIENT_SECRET: process.env.AUTHENTIK_CLIENT_SECRET,
  AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
  AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
};

function restoreForwardAuthEnv() {
  process.env.AUTHENTIK_CLIENT_SECRET = PREV_ENV.AUTHENTIK_CLIENT_SECRET;
  process.env.AUTHENTIK_ISSUER = PREV_ENV.AUTHENTIK_ISSUER;
  process.env.AUTHENTIK_AUDIENCE = PREV_ENV.AUTHENTIK_AUDIENCE;
  vi.resetModules();
}

interface SignOptions {
  key?: Uint8Array;
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  expiresAt?: string | number;
}

async function signToken(claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> {
  const { key = HMAC_KEY, issuer = AUTHENTIK_ISSUER, audience = AUTHENTIK_AUDIENCE, expiresAt = '10m' } = options;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256' })
    .setIssuedAt(options.issuedAt)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expiresAt)
    .sign(key);
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Built by hand because jose's SignJWT refuses to produce an unsigned token or
// one whose header disagrees with the key.
function handBuiltToken(header: Record<string, string>, signature: string): string {
  const payload = {
    email: 'reseller@example.com',
    iss: AUTHENTIK_ISSUER,
    aud: AUTHENTIK_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  return `${encodeSegment(header)}.${encodeSegment(payload)}.${signature}`;
}

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
let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;

async function buildTokens() {
  const email = { email: 'reseller@example.com' };
  validToken = await signToken(email);

  // Signed with a secret the app doesn't have -- proves verification is
  // pinned to the real client_secret, not just "any well-formed HS256 JWT".
  wrongSignatureToken = await signToken(email, { key: WRONG_HMAC_KEY });

  // alg: none -- an unsigned token. Proves verifyAuthentikJwt rejects it
  // rather than trusting an unsigned/"none"-algorithm assertion.
  noneAlgToken = handBuiltToken({ alg: 'none', typ: 'JWT' }, '');

  // A header claiming alg: RS256 -- proves algorithms: ['HS256'] pins the
  // accepted algorithm rather than trusting whatever the token's own
  // header claims. jose checks `alg` against the allowed-algorithms list
  // before it ever looks at the signature bytes (JOSEAlgNotAllowed fires
  // first), so the signature segment here doesn't need to be real -- only
  // structurally valid base64url.
  wrongAlgorithmToken = handBuiltToken(
    { alg: 'RS256', typ: 'JWT' },
    Buffer.from('not-a-real-signature').toString('base64url'),
  );

  wrongIssuerToken = await signToken(email, { issuer: 'https://not-the-real-idp.example.com/' });
  missingEmailToken = await signToken({});
  emptyEmailToken = await signToken({ email: '' });

  // JWT payloads are arbitrary JSON, not TypeScript-typed -- an `email`
  // claim shaped as a number (rather than absent or an empty string) is a
  // distinct case from missingEmailToken/emptyEmailToken above: it proves
  // verifyAuthentikJwt's `typeof email !== 'string'` check, not just the
  // `.length === 0` half of that condition.
  numericEmailToken = await signToken({ email: 12345 });

  const nowSeconds = Math.floor(Date.now() / 1000);
  expiredToken = await signToken(email, { issuedAt: nowSeconds - 7200, expiresAt: nowSeconds - 3600 });
  wrongAudienceToken = await signToken(email, { audience: 'some-other-audience' });
}

// lib/forwardAuth.ts reads env + builds config at *module load* time, so
// the env vars must be set and the module (re-)imported fresh, per the
// pattern used in tests/api/tenant-isolation.test.ts (AC13).
function useForwardAuth(isConfigured: boolean) {
  beforeAll(async () => {
    await buildTokens();
    if (isConfigured) {
      process.env.AUTHENTIK_CLIENT_SECRET = AUTHENTIK_CLIENT_SECRET;
      process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
      process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    } else {
      delete process.env.AUTHENTIK_CLIENT_SECRET;
      delete process.env.AUTHENTIK_ISSUER;
      delete process.env.AUTHENTIK_AUDIENCE;
    }
    vi.resetModules();
    ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
  });

  afterEach(() => {
    jwtVerifyBox.impl = undefined;
  });

  afterAll(restoreForwardAuthEnv);
}

describe('verifyAuthentikJwt when forward-auth is configured › valid and bad signatures', () => {
  useForwardAuth(true);

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
});

describe('verifyAuthentikJwt when forward-auth is configured › email claims', () => {
  useForwardAuth(true);

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
});

describe('verifyAuthentikJwt when forward-auth is configured › malformed, expired and wrong audience', () => {
  useForwardAuth(true);

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
});

describe('verifyAuthentikJwt when forward-auth is configured › non-Error failures', () => {
  useForwardAuth(true);

  it('fails closed with reason unknown when a non-Error value is thrown (never crashes the request)', async () => {
    // Deliberately not an Error instance -- exercising classifyVerificationError's
    // final `unknown` fallback for a thrown value that isn't even `instanceof Error`.
    // Real HS256 verification never produces this itself; it's a defensive
    // path for whatever jose might throw that this module doesn't otherwise
    // classify.
    const thrown: unknown = 'not an Error instance';
    jwtVerifyBox.impl = () => {
      throw thrown;
    };

    const result = await verifyAuthentikJwt(validToken);

    expect(result).toMatchObject({ status: 'invalid', reason: 'unknown' });
  });
});

describe('verifyAuthentikJwt when forward-auth is not configured', () => {
  useForwardAuth(false);

  it('returns not_configured immediately without attempting verification', async () => {
    const result = await verifyAuthentikJwt(validToken);
    expect(result).toEqual({ status: 'not_configured' });
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
  afterEach(restoreForwardAuthEnv);

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
// DB via lib/tenantAuth.ts's createTenant()/tests/tenantFixtures.ts's
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
