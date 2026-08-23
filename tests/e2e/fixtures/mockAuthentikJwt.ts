import { SignJWT } from 'jose';

// ---------------------------------------------------------------------------
// Mock Authentik forward-auth JWT signing, for E2E tests only.
//
// lib/forwardAuth.ts verifies HS256 tokens against a static, symmetric
// AUTHENTIK_CLIENT_SECRET -- real, synchronous HMAC crypto with no network
// call anywhere in the path. That means an E2E test needs no mock HTTP
// server, no fixed port, no Playwright globalSetup coordination, and no
// cross-process signing surface: this fixture used to be a real
// http.createServer standing in for Authentik's JWKS endpoint (an earlier,
// RS256-based design -- see git history), all of which is unnecessary now.
// playwright.config.ts sets AUTHENTIK_CLIENT_SECRET/AUTHENTIK_ISSUER/
// AUTHENTIK_AUDIENCE directly from the constants below, and any spec --
// running in whichever Playwright worker process -- can just call
// signMockAuthentikJwt() itself.
// ---------------------------------------------------------------------------

export const MOCK_AUTHENTIK_CLIENT_SECRET = 'e2e-test-client-secret-do-not-use-in-prod';
export const MOCK_AUTHENTIK_ISSUER = 'https://mock-authentik.example.invalid/application/o/resale/';
export const MOCK_AUTHENTIK_AUDIENCE = 'internal-inventory-app';

const HMAC_KEY = new TextEncoder().encode(MOCK_AUTHENTIK_CLIENT_SECRET);

export interface SignMockAuthentikJwtOptions {
  /** Overrides the default issuer -- set to something else to test a rejected mismatch. */
  issuer?: string;
  /** Overrides the default audience -- set to something else to test a rejected mismatch. */
  audience?: string;
  /** jose "time span" string, e.g. '10m', '-1m' for an already-expired token. Defaults to '10m'. */
  expiresIn?: string;
  /** Overrides the protected header's `alg`/`kid` -- used to build deliberately-invalid tokens. Defaults to HS256 / 'authentik-hs256'. */
  protectedHeader?: Record<string, unknown>;
}

/**
 * Sign a JWT against MOCK_AUTHENTIK_CLIENT_SECRET, matching what
 * lib/forwardAuth.ts verifies against when playwright.config.ts's webServer
 * sets AUTHENTIK_CLIENT_SECRET to the same constant.
 */
export async function signMockAuthentikJwt(
  claims: Record<string, unknown> = {},
  options: SignMockAuthentikJwtOptions = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: 'authentik-hs256', ...options.protectedHeader })
    .setIssuedAt()
    .setIssuer(options.issuer ?? MOCK_AUTHENTIK_ISSUER)
    .setAudience(options.audience ?? MOCK_AUTHENTIK_AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(HMAC_KEY);
}
