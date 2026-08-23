import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, errors as joseErrors } from 'jose';

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

// ---------------------------------------------------------------------------
// Fail-closed verification result contract (2026-08-01 security fix).
//
// The original contract collapsed every failure mode -- forward-auth not
// configured, bad signature, expired token, wrong iss/aud, alg-confusion,
// AND "the verifier itself could not run the check" (JWKS unreachable,
// timeout, malformed JWKS response) -- into a single `null`, and the caller
// (middleware.ts) treated `null` identically to "no credential was ever
// presented": pass the request through untouched. That conflates two very
// different states:
//   - No credential presented at all (no X-Authentik-Jwt header) -- a
//     legitimate, expected state for local-dev/Tailscale-LAN access that
//     never goes through Authentik's proxy. Passing through is correct here
//     because the app's own downstream tenant-session check still gates the
//     request; forward-auth simply has nothing to verify.
//   - A credential WAS presented and verification could not confirm it --
//     whether because the token is cryptographically/semantically invalid,
//     or because the verifier's own dependency (the JWKS endpoint) is
//     unreachable. Passing this through identically to "no credential" means
//     an outage or misconfiguration of the JWKS endpoint silently disables
//     SSO identity-mapping fleet-wide while the process keeps running with
//     zero log output and zero restarts -- indistinguishable from "working
//     fine" in every signal `systemctl`/`journalctl` expose.
//
// verifyAuthentikJwt() now returns a discriminated result so the caller can
// -- and must -- treat those two states differently: `not_configured` is the
// "no credential applies here" case (unchanged pass-through behavior);
// `invalid` carries a specific, loggable/countable reason and must be denied
// by the caller, never silently passed through. See middleware.ts's
// forwardAuthVerificationFailedResponse().
// ---------------------------------------------------------------------------

/**
 * Why a presented JWT failed verification. Deliberately more granular than
 * a boolean so the caller can log and count each class separately (see
 * CONVENTIONS.md #18's "did-nothing rule" and level discipline) --
 * "the JWKS endpoint is unreachable" and "this specific token is expired"
 * are different operational problems with different owners and different
 * urgency, and collapsing them back into one string in a log line would
 * reproduce the exact silence this fix exists to remove.
 *
 * - `jwks_unreachable` -- the JWKS document itself could not be fetched or
 *   parsed: network failure, DNS failure, non-200 response, malformed JSON,
 *   or the fetch timing out (JWKS_FETCH_TIMEOUT_MS above). A verifier-side
 *   problem, not a property of the presented token.
 * - `key_not_found` -- the JWKS document was fetched fine, but no key in it
 *   (unambiguously) matches the token's `kid`. This is the expected
 *   transient signature of an in-flight Authentik key rotation as well as a
 *   token signed by a key that was never valid; both surface identically to
 *   jose (JWKSNoMatchingKey/JWKSMultipleMatchingKeys/JWKSInvalid/JWKInvalid),
 *   so they share one reason rather than one this module cannot actually
 *   distinguish further.
 * - `invalid_signature` -- signature verification failed against a key that
 *   loaded successfully (`kid` matched, bytes don't).
 * - `invalid_algorithm` -- header `alg` was not exactly `RS256`: covers
 *   `alg: none` and any algorithm-confusion attempt.
 * - `token_expired` -- `exp` claim in the past.
 * - `invalid_issuer` / `invalid_audience` -- `iss`/`aud` claim mismatch
 *   against the pinned `AUTHENTIK_ISSUER`/`AUTHENTIK_AUDIENCE`.
 * - `malformed_token` -- not a structurally valid compact JWS (e.g. the
 *   literal string `'not-a-jwt'`), or another claim-shape problem jose does
 *   not attribute a claim name to.
 * - `missing_email_claim` -- signature and claims verified, but the `email`
 *   claim is absent, empty, or not a string.
 * - `unknown` -- a thrown value that is not even an `Error` instance.
 *   Genuinely unclassified; kept distinct from `jwks_unreachable` rather
 *   than folded into it so it doesn't dilute that reason's alerting signal.
 */
export type ForwardAuthFailureReason =
  | 'jwks_unreachable'
  | 'key_not_found'
  | 'invalid_signature'
  | 'invalid_algorithm'
  | 'token_expired'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'malformed_token'
  | 'missing_email_claim'
  | 'unknown';

export type ForwardAuthResult =
  | { status: 'not_configured' }
  | { status: 'verified'; email: string }
  | { status: 'invalid'; reason: ForwardAuthFailureReason; keyId?: string; alg?: string };

/**
 * Best-effort extraction of the token's `kid` (key id) and `alg` header
 * fields, for logging only -- never used in the verification decision
 * itself (the decision uses jose's own internal header check against the
 * pinned `algorithms: ['RS256']` option). Both are public, non-secret
 * values already visible in the token's base64 header segment and (for
 * `kid`) in the JWKS document, so logging them is safe per CONVENTIONS.md
 * #18's redaction deny-list. `alg` is what makes an `invalid_algorithm`
 * failure diagnosable from logs alone -- without it, "the alg was wrong"
 * carries no information about *which* alg actually showed up (a stray
 * HS256/none token vs. a genuine algorithm-confusion attempt look
 * identical in the log otherwise). Returns `{}` (never throws) if the
 * token isn't even well-formed enough to have a decodable header.
 */
function safeDecodeHeaderFields(jwt: string): { kid?: string; alg?: string } {
  try {
    const header = decodeProtectedHeader(jwt);
    return {
      kid: typeof header.kid === 'string' ? header.kid : undefined,
      alg: typeof header.alg === 'string' ? header.alg : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Map a thrown verification error to a ForwardAuthFailureReason. Ordered
 * most-specific-subclass first: several jose error classes share a common
 * `JOSEError` base, so a generic check must come after every subclass check
 * that needs its own reason, or the specific reasons below would never be
 * reached.
 *
 * Any `Error` that isn't one of jose's own classes (a raw `TypeError` from a
 * failed `fetch`, an `AggregateError` from a DNS failure, etc.) is bucketed
 * as `jwks_unreachable`: the only network call anywhere in this function's
 * call graph is the JWKS fetch inside `getJwksSet()`/`jwtVerify()`, so an
 * unrecognized `Error` reaching this catch is, in practice, that fetch
 * failing in a way jose didn't wrap in its own error type.
 */
function classifyVerificationError(err: unknown): ForwardAuthFailureReason {
  if (err instanceof joseErrors.JWTExpired) {
    return 'token_expired';
  }

  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') {
      return 'invalid_issuer';
    }
    if (err.claim === 'aud') {
      return 'invalid_audience';
    }
    return 'malformed_token';
  }

  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return 'invalid_algorithm';
  }

  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid_signature';
  }

  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    return 'malformed_token';
  }

  if (
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys ||
    err instanceof joseErrors.JWKSInvalid ||
    err instanceof joseErrors.JWKInvalid
  ) {
    return 'key_not_found';
  }

  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JOSEError) {
    return 'jwks_unreachable';
  }

  if (err instanceof Error) {
    return 'jwks_unreachable';
  }

  return 'unknown';
}

/**
 * Verify a forward-auth JWT (the one Authentik's proxy places in the
 * X-Authentik-Jwt header) against the pinned JWKS/issuer/audience, and
 * return its `email` claim.
 *
 * Never throws. Returns one of three states -- see ForwardAuthResult above:
 *   - `{ status: 'not_configured' }` when forward-auth is disabled for this
 *     deployment (all three env vars unset). No verification is attempted.
 *   - `{ status: 'verified', email }` when the token's signature, `alg`,
 *     `iss`, `aud`, and expiry all check out against the pinned JWKS, and
 *     its `email` claim is a non-empty string.
 *   - `{ status: 'invalid', reason, keyId? }` for every other case: bad
 *     signature, expired token, wrong `iss`/`aud`, a header `alg` other than
 *     exactly RS256 (`alg: none` and algorithm-confusion attempts included --
 *     `algorithms: ['RS256']` below is what pins it), JWKS fetch network
 *     failure/timeout, a malformed JWKS response, a `kid` that matches no
 *     key (key-rotation window), or a missing/empty/non-string `email`
 *     claim. `reason` is a stable ForwardAuthFailureReason; `keyId` is the
 *     token's `kid` header when decodable, for logging only.
 *
 * Callers MUST NOT treat `invalid` the same as `not_configured` -- a
 * presented-but-unverifiable credential must be denied (fail closed), while
 * "not configured" means forward-auth has nothing to verify here and the
 * app's own downstream session check still applies. See middleware.ts.
 */
export async function verifyAuthentikJwt(jwt: string): Promise<ForwardAuthResult> {
  if (
    AUTHENTIK_JWKS_URL === undefined ||
    AUTHENTIK_ISSUER === undefined ||
    AUTHENTIK_AUDIENCE === undefined
  ) {
    return { status: 'not_configured' };
  }

  const { kid: keyId, alg } = safeDecodeHeaderFields(jwt);

  try {
    const { payload } = await jwtVerify(jwt, getJwksSet(), {
      algorithms: ['RS256'],
      issuer: AUTHENTIK_ISSUER,
      audience: AUTHENTIK_AUDIENCE,
    });

    const email = payload.email;
    if (typeof email !== 'string' || email.length === 0) {
      return { status: 'invalid', reason: 'missing_email_claim', keyId, alg };
    }

    return { status: 'verified', email };
  } catch (err) {
    return { status: 'invalid', reason: classifyVerificationError(err), keyId, alg };
  }
}
