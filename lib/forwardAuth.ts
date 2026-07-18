import { createRemoteJWKSet, jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// Env config -- pinned server-side, never trusted from the incoming request.
//
// The Authentik forward-auth proxy sets an X-Authentik-Meta-Jwks header on
// forwarded requests, but that header is attacker-forgeable (anything sent
// by the client/proxy hop can be spoofed by whatever sits in front of this
// app) -- it must never be used as a fetch target. Instead the JWKS URL,
// issuer, and audience are pinned via server-side env vars, set once at
// deploy time alongside the reverse-proxy config.
//
// All-or-nothing validation: a partially-configured deployment (e.g. someone
// set AUTHENTIK_ISSUER while rotating config but forgot the other two) must
// fail loudly at startup, not silently skip verification or 500 on the first
// request. Checked at module load so a broken deployment never serves a
// single request (AC11).
// ---------------------------------------------------------------------------
const rawJwksUrl = process.env.AUTHENTIK_JWKS_URL;
const rawIssuer = process.env.AUTHENTIK_ISSUER;
const rawAudience = process.env.AUTHENTIK_AUDIENCE;

const setCount = [rawJwksUrl, rawIssuer, rawAudience].filter(
  (value) => value !== undefined && value !== '',
).length;

if (setCount !== 0 && setCount !== 3) {
  throw new Error(
    'Forward-auth env misconfigured: AUTHENTIK_JWKS_URL, AUTHENTIK_ISSUER, and ' +
      'AUTHENTIK_AUDIENCE must be either all set or all unset (got ' +
      `${setCount}/3 set). Partial config would silently disable or break JWT ` +
      'verification -- refusing to start.',
  );
}

// jose's createRemoteJWKSet requires a URL instance, and its scheme is
// validated here (not deferred to fetch time) so a plaintext http:// endpoint
// -- which would leak the JWKS fetch (and any redirect chain) unencrypted --
// is rejected at startup rather than discovered in production traffic.
let parsedJwksUrl: URL | undefined;
if (rawJwksUrl !== undefined) {
  try {
    parsedJwksUrl = new URL(rawJwksUrl);
  } catch {
    throw new Error(`AUTHENTIK_JWKS_URL is not a valid URL: ${rawJwksUrl}`);
  }
  // Loopback-only, non-production exception: local E2E tests (see
  // tests/e2e/fixtures/mockJwksServer.ts) need to point this at an
  // in-process mock JWKS server without provisioning a self-signed TLS cert
  // just to satisfy this check. Scoped narrowly on two axes so it can never
  // become a blanket downgrade: (1) NODE_ENV !== 'production' -- a real
  // deployment always sets NODE_ENV=production, so this never relaxes
  // anything in prod regardless of hostname; (2) the hostname must be
  // exactly 127.0.0.1 or localhost -- an arbitrary non-loopback http://
  // host is rejected exactly as before, in every environment, because
  // nothing about "not production" makes plaintext-JWKS-fetch-from-a-real-
  // host safe.
  const isLoopbackHttpException =
    process.env.NODE_ENV !== 'production' &&
    parsedJwksUrl.protocol === 'http:' &&
    (parsedJwksUrl.hostname === '127.0.0.1' || parsedJwksUrl.hostname === 'localhost');

  if (parsedJwksUrl.protocol !== 'https:' && !isLoopbackHttpException) {
    throw new Error(
      `AUTHENTIK_JWKS_URL must use https:// (got "${parsedJwksUrl.protocol}//..."). ` +
        'Fetching the JWKS over plaintext http would let a network-position ' +
        'attacker substitute their own signing keys.',
    );
  }
}

// Undefined when forward-auth is not configured for this deployment (all
// three env vars unset), non-undefined and mutually consistent otherwise
// (enforced by the all-or-nothing check above). Only consumed within this
// module (by verifyAuthentikJwt below) -- not exported, since nothing
// outside this file needs them (test files define their own local mock
// values rather than importing these).
const AUTHENTIK_JWKS_URL = rawJwksUrl;
const AUTHENTIK_ISSUER = rawIssuer;
const AUTHENTIK_AUDIENCE = rawAudience;

// How long a fetch to the JWKS endpoint is allowed to hang before jose gives
// up. jose defaults to no explicit timeout on the underlying request; an
// unreachable IdP would otherwise be able to hang verification indefinitely.
const JWKS_FETCH_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Lazily-initialized, module-level JWKS set.
//
// Deliberately a single `let`, not a Map keyed by URL -- this is a
// single-IdP, single-app deployment with exactly one pinned JWKS URL, so a
// keyed cache structure would be unnecessary complexity. `createRemoteJWKSet`
// itself is what caches fetched keys (and re-fetches on a cache miss / kid
// rotation), so this accessor only needs to construct that cache once and
// reuse it across requests/invocations (AC10).
// ---------------------------------------------------------------------------
let jwksSet: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * Return the module-level cached JWKS set, constructing it on first call
 * from AUTHENTIK_JWKS_URL. Throws if forward-auth is not configured
 * (AUTHENTIK_JWKS_URL unset) -- verifyAuthentikJwt below is expected to
 * check configuration before calling this, or to let this throw propagate
 * as a hard failure.
 */
function getJwksSet(): ReturnType<typeof createRemoteJWKSet> {
  if (parsedJwksUrl === undefined) {
    throw new Error(
      'getJwksSet() called but AUTHENTIK_JWKS_URL is not configured -- ' +
        'forward-auth is disabled for this deployment.',
    );
  }
  if (jwksSet === undefined) {
    jwksSet = createRemoteJWKSet(parsedJwksUrl, {
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
    });
  }
  return jwksSet;
}

/**
 * Verify a forward-auth JWT (the one Authentik's proxy places in the
 * X-Authentik-Jwt header) against the pinned JWKS/issuer/audience, and
 * return its `email` claim.
 *
 * Returns `null` -- never throws -- for every failure mode: forward-auth not
 * configured for this deployment, bad signature, expired token, wrong
 * `iss`/`aud`, a header `alg` other than exactly RS256 (this includes
 * `alg: none` and any algorithm-confusion attempt -- `algorithms: ['RS256']`
 * below is what pins it), JWKS fetch network failure/timeout, a malformed
 * JWKS response, or a missing/empty/non-string `email` claim. Callers must
 * treat `null` as "unauthenticated" and never distinguish failure reasons
 * from the return value (the reason is not signaled, by design -- this is a
 * boundary that only ever says yes or no).
 */
export async function verifyAuthentikJwt(jwt: string): Promise<{ email: string } | null> {
  if (
    AUTHENTIK_JWKS_URL === undefined ||
    AUTHENTIK_ISSUER === undefined ||
    AUTHENTIK_AUDIENCE === undefined
  ) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(jwt, getJwksSet(), {
      algorithms: ['RS256'],
      issuer: AUTHENTIK_ISSUER,
      audience: AUTHENTIK_AUDIENCE,
    });

    const email = payload.email;
    if (typeof email !== 'string' || email.length === 0) {
      return null;
    }

    return { email };
  } catch {
    return null;
  }
}
