import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
} from 'jose';
import crypto from 'crypto';
import { createTestTenant } from '../helpers/tenant';
import { findTenantByEmail, createTenant } from '@/lib/tenantAuth';

// verifyAuthentikJwt() calls the module-level getJwksSet(), which wraps
// jose's createRemoteJWKSet -- a real network-fetching function. To test
// signature/claim verification without hitting the network, we mock jose's
// createRemoteJWKSet to instead hand back an in-memory resolver built from
// createLocalJWKSet(), seeded with a locally generated key pair. This is the
// least invasive option: lib/forwardAuth.ts is untouched, and jwtVerify's
// real behavior (claim/alg/exp checking) still runs for real against our
// local keys.
//
// vi.hoisted() is required because vi.mock() factories are hoisted above
// this file's own top-level statements -- without it, the factory would
// close over a not-yet-initialized binding.
const jwksResolverBox = vi.hoisted(() => ({
  resolver: undefined as JWTVerifyGetKey | undefined,
}));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => {
      if (jwksResolverBox.resolver === undefined) {
        throw new Error('test JWKS resolver not configured yet');
      }
      return jwksResolverBox.resolver;
    }),
  };
});

const AUTHENTIK_JWKS_URL = 'https://authentik.example.com/application/o/resale/jwks/';
const AUTHENTIK_ISSUER = 'https://authentik.example.com/application/o/resale/';
const AUTHENTIK_AUDIENCE = 'internal-inventory-app';

describe('verifyAuthentikJwt', () => {
  let validToken: string;
  let wrongSignatureToken: string;
  let noneAlgToken: string;
  let wrongIssuerToken: string;
  let missingEmailToken: string;
  let emptyEmailToken: string;
  let numericEmailToken: string;
  let expiredToken: string;
  let wrongAudienceToken: string;
  let algConfusionToken: string;
  let rotatedAwayKeyToken: string;

  const prevEnv = {
    AUTHENTIK_JWKS_URL: process.env.AUTHENTIK_JWKS_URL,
    AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
    AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
  };

  beforeAll(async () => {
    // Real (signing) key pair -- its public half is published in the mocked
    // JWKS below, so tokens signed with it verify successfully.
    const { publicKey, privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-signing-key';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    // A second, unrelated key pair -- its private key never appears in the
    // JWKS, so anything signed with it must fail verification.
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });

    jwksResolverBox.resolver = createLocalJWKSet({ keys: [publicJwk] });

    validToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);

    wrongSignatureToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(otherPrivateKey);

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

    wrongIssuerToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer('https://not-the-real-idp.example.com/')
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);

    missingEmailToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);

    emptyEmailToken = await new SignJWT({ email: '' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);

    // JWT payloads are arbitrary JSON, not TypeScript-typed -- an `email`
    // claim shaped as a number (rather than absent or an empty string) is a
    // distinct case from missingEmailToken/emptyEmailToken above: it proves
    // verifyAuthentikJwt's `typeof email !== 'string'` check, not just the
    // `.length === 0` half of that condition.
    numericEmailToken = await new SignJWT({ email: 12345 })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);

    const nowSeconds = Math.floor(Date.now() / 1000);
    expiredToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt(nowSeconds - 7200)
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime(nowSeconds - 3600)
      .sign(privateKey);

    wrongAudienceToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience('some-other-audience')
      .setExpirationTime('10m')
      .sign(privateKey);

    // Classic RS256-to-HS256 algorithm-confusion attack: the header claims
    // HS256, but the "secret" used is the RSA public key's exported SPKI
    // PEM bytes -- a value an attacker can obtain from the (public) JWKS
    // endpoint. If the verifier trusted the header's `alg` instead of
    // pinning `algorithms: ['RS256']`, an attacker could forge tokens this
    // way without ever knowing the real RSA private key.
    const publicKeyPem = await exportSPKI(publicKey);
    algConfusionToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(publicKeyPem));

    // A `kid` that does not exist in the published JWKS at all -- the
    // key-rotation-window signature: the signing key was valid (it's the
    // same real `privateKey` used for validToken above), but the JWKS
    // resolver can't find ANY key matching this kid, which is exactly what
    // happens for a token minted just before/during Authentik rotating its
    // signing key, before this app's JWKS cache has caught up. Distinct from
    // wrongSignatureToken above, where the kid IS found but the signature
    // bytes don't verify against it.
    rotatedAwayKeyToken = await new SignJWT({ email: 'reseller@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'rotated-away-key-id' })
      .setIssuedAt()
      .setIssuer(AUTHENTIK_ISSUER)
      .setAudience(AUTHENTIK_AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);
  });

  afterAll(() => {
    process.env.AUTHENTIK_JWKS_URL = prevEnv.AUTHENTIK_JWKS_URL;
    process.env.AUTHENTIK_ISSUER = prevEnv.AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = prevEnv.AUTHENTIK_AUDIENCE;
    vi.resetModules();
  });

  describe('when forward-auth is configured', () => {
    // lib/forwardAuth.ts reads env + builds config at *module load* time, so
    // the env vars must be set and the module (re-)imported fresh, per the
    // pattern used in tests/api/tenant-isolation.test.ts (AC13).
    let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;
    let workingJwksResolver: JWTVerifyGetKey | undefined;

    beforeAll(async () => {
      process.env.AUTHENTIK_JWKS_URL = AUTHENTIK_JWKS_URL;
      process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
      process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
      vi.resetModules();
      ({ verifyAuthentikJwt } = await import('@/lib/forwardAuth'));
      workingJwksResolver = jwksResolverBox.resolver;
    });

    // A couple of tests below (JWKS-throws / JWKS-rejects) temporarily swap
    // jwksResolverBox.resolver out for a broken one and need a *fresh*
    // module import to pick it up (verifyAuthentikJwt's module-level
    // jwksSet is a lazily-initialized singleton, cached on first use -- see
    // lib/forwardAuth.ts's getJwksSet). Restoring the working resolver here
    // guarantees every other test in this block keeps using a healthy JWKS
    // resolver, regardless of test order.
    afterEach(() => {
      jwksResolverBox.resolver = workingJwksResolver;
    });

    it('verifies a validly signed token and returns its email claim', async () => {
      const result = await verifyAuthentikJwt(validToken);
      expect(result).toEqual({ status: 'verified', email: 'reseller@example.com' });
    });

    it('rejects a token signed with the wrong key (bad signature), reason invalid_signature, and still extracts the kid for logging', async () => {
      const result = await verifyAuthentikJwt(wrongSignatureToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_signature',
        keyId: 'test-signing-key',
      });
    });

    it('rejects an unsigned alg:none token with reason invalid_algorithm', async () => {
      const result = await verifyAuthentikJwt(noneAlgToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm' });
    });

    it('rejects a token with the wrong issuer with reason invalid_issuer', async () => {
      const result = await verifyAuthentikJwt(wrongIssuerToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'invalid_issuer',
        keyId: 'test-signing-key',
      });
    });

    it('rejects a validly signed token with no email claim with reason missing_email_claim', async () => {
      const result = await verifyAuthentikJwt(missingEmailToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'missing_email_claim',
        keyId: 'test-signing-key',
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

    it('rejects a structurally invalid token string with reason malformed_token and no extractable kid', async () => {
      const result = await verifyAuthentikJwt('not-a-jwt');
      expect(result).toEqual({ status: 'invalid', reason: 'malformed_token', keyId: undefined });
    });

    it('rejects an expired token with reason token_expired', async () => {
      const result = await verifyAuthentikJwt(expiredToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'token_expired' });
    });

    it('rejects a token with the wrong audience with reason invalid_audience', async () => {
      const result = await verifyAuthentikJwt(wrongAudienceToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_audience' });
    });

    it('rejects an RS256-to-HS256 algorithm-confusion token (reason invalid_algorithm) even though its signature is internally consistent', async () => {
      const result = await verifyAuthentikJwt(algConfusionToken);
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_algorithm' });
    });

    it('rejects a token whose kid matches no published key with reason key_not_found (the key-rotation-window signature)', async () => {
      const result = await verifyAuthentikJwt(rotatedAwayKeyToken);
      expect(result).toEqual({
        status: 'invalid',
        reason: 'key_not_found',
        keyId: 'rotated-away-key-id',
      });
    });

    it('fails closed with reason jwks_unreachable when the JWKS resolver throws, e.g. a malformed JWKS document', async () => {
      jwksResolverBox.resolver = (() => {
        throw new Error('malformed JWKS document');
      }) as unknown as JWTVerifyGetKey;
      vi.resetModules();
      const { verifyAuthentikJwt: freshVerify } = await import('@/lib/forwardAuth');

      const result = await freshVerify(validToken);

      expect(result).toMatchObject({ status: 'invalid', reason: 'jwks_unreachable' });
    });

    it('fails closed with reason jwks_unreachable when the JWKS endpoint fetch rejects, e.g. a network failure/timeout', async () => {
      jwksResolverBox.resolver = (async () => {
        throw new Error('fetch failed: network timeout');
      }) as unknown as JWTVerifyGetKey;
      vi.resetModules();
      const { verifyAuthentikJwt: freshVerify } = await import('@/lib/forwardAuth');

      const result = await freshVerify(validToken);

      expect(result).toMatchObject({ status: 'invalid', reason: 'jwks_unreachable' });
    });

    it('fails closed with reason unknown when a non-Error value is thrown (never crashes the request)', async () => {
      jwksResolverBox.resolver = (() => {
        // Deliberately not an Error instance -- exercising classifyVerificationError's
        // final `unknown` fallback for a thrown value that isn't even `instanceof Error`.
        throw 'not an Error instance';
      }) as unknown as JWTVerifyGetKey;
      vi.resetModules();
      const { verifyAuthentikJwt: freshVerify } = await import('@/lib/forwardAuth');

      const result = await freshVerify(validToken);

      expect(result).toMatchObject({ status: 'invalid', reason: 'unknown' });
    });

    it('constructs the remote JWKS set exactly once (AC10) and passes the fetch timeout, even across multiple verify calls', async () => {
      vi.resetModules();
      const mockedCreateRemoteJWKSet = vi.mocked(createRemoteJWKSet);
      mockedCreateRemoteJWKSet.mockClear();
      const { verifyAuthentikJwt: freshVerify } = await import('@/lib/forwardAuth');

      await freshVerify(validToken);
      await freshVerify(validToken);
      await freshVerify(wrongSignatureToken);

      expect(mockedCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
      expect(mockedCreateRemoteJWKSet).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ timeoutDuration: 5000 }),
      );
    });
  });

  describe('when forward-auth is not configured', () => {
    let verifyAuthentikJwt: typeof import('@/lib/forwardAuth').verifyAuthentikJwt;

    beforeAll(async () => {
      delete process.env.AUTHENTIK_JWKS_URL;
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
// This exists because Stryker's mutation run on lib/forwardAuth.ts showed
// zero coverage on the all-or-nothing check, the URL-parse failure, the
// loopback-http exception, and the https-required branch -- the two
// "configured"/"not configured" describes above only ever import the module
// with a fully-valid https config or nothing at all, never touching these
// module-load failure paths.
describe('lib/forwardAuth.ts module-load configuration validation', () => {
  const prevEnv = {
    AUTHENTIK_JWKS_URL: process.env.AUTHENTIK_JWKS_URL,
    AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
    AUTHENTIK_AUDIENCE: process.env.AUTHENTIK_AUDIENCE,
  };

  afterEach(() => {
    process.env.AUTHENTIK_JWKS_URL = prevEnv.AUTHENTIK_JWKS_URL;
    process.env.AUTHENTIK_ISSUER = prevEnv.AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = prevEnv.AUTHENTIK_AUDIENCE;
    // NODE_ENV is typed read-only on process.env (@types/node) -- vi.stubEnv
    // is Vitest's own mechanism for overriding it per-test; unstubAllEnvs()
    // restores the real value afterward.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws at import time when exactly one of the three env vars is set', async () => {
    process.env.AUTHENTIK_JWKS_URL = AUTHENTIK_JWKS_URL;
    delete process.env.AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'Forward-auth env misconfigured: AUTHENTIK_JWKS_URL, AUTHENTIK_ISSUER, and ' +
        'AUTHENTIK_AUDIENCE must be either all set or all unset (got 1/3 set). ' +
        'Partial config would silently disable or break JWT verification -- refusing to start.',
    );
  });

  it('throws at import time when exactly two of the three env vars are set', async () => {
    process.env.AUTHENTIK_JWKS_URL = AUTHENTIK_JWKS_URL;
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    delete process.env.AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'Forward-auth env misconfigured: AUTHENTIK_JWKS_URL, AUTHENTIK_ISSUER, and ' +
        'AUTHENTIK_AUDIENCE must be either all set or all unset (got 2/3 set). ' +
        'Partial config would silently disable or break JWT verification -- refusing to start.',
    );
  });

  it('throws at import time when AUTHENTIK_JWKS_URL is not a valid URL', async () => {
    process.env.AUTHENTIK_JWKS_URL = 'not a url';
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'AUTHENTIK_JWKS_URL is not a valid URL: not a url',
    );
  });

  it('throws when AUTHENTIK_JWKS_URL is http:// against a non-loopback host, even outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.AUTHENTIK_JWKS_URL = 'http://authentik.example.com/jwks/';
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'AUTHENTIK_JWKS_URL must use https:// (got "http://..."). Fetching the JWKS ' +
        'over plaintext http would let a network-position attacker substitute their ' +
        'own signing keys.',
    );
  });

  it('throws when AUTHENTIK_JWKS_URL is http://127.0.0.1 in production (the loopback exception never applies in prod)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AUTHENTIK_JWKS_URL = 'http://127.0.0.1:9999/jwks';
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).rejects.toThrow(
      'AUTHENTIK_JWKS_URL must use https:// (got "http://..."). Fetching the JWKS ' +
        'over plaintext http would let a network-position attacker substitute their ' +
        'own signing keys.',
    );
  });

  it.each(['127.0.0.1', 'localhost'])(
    'allows AUTHENTIK_JWKS_URL to be http://%s outside production (the narrow test/E2E exception)',
    async (hostname) => {
      vi.stubEnv('NODE_ENV', 'test');
      process.env.AUTHENTIK_JWKS_URL = `http://${hostname}:9999/jwks`;
      process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
      process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
      vi.resetModules();

      await expect(import('@/lib/forwardAuth')).resolves.toBeDefined();
    },
  );

  it('accepts a valid https:// AUTHENTIK_JWKS_URL with no throw, regardless of NODE_ENV', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AUTHENTIK_JWKS_URL = AUTHENTIK_JWKS_URL;
    process.env.AUTHENTIK_ISSUER = AUTHENTIK_ISSUER;
    process.env.AUTHENTIK_AUDIENCE = AUTHENTIK_AUDIENCE;
    vi.resetModules();

    await expect(import('@/lib/forwardAuth')).resolves.toBeDefined();
  });

  it('does not throw at import time when all three env vars are unset', async () => {
    delete process.env.AUTHENTIK_JWKS_URL;
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
