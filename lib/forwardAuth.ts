import { decodeProtectedHeader, jwtVerify, errors as joseErrors } from 'jose';

// ---------------------------------------------------------------------------
// Env config -- pinned server-side, never trusted from the incoming request.
//
// Authentik's Proxy Provider (the "forward auth (single application)" mode
// this deployment uses) can never sign its id tokens with RS256: its own
// ProxyProvider.set_oauth_defaults() (authentik/providers/proxy/models.py)
// unconditionally sets signing_key = None on every provider, on every
// authentik-server/worker startup, for every Proxy Provider -- not a
// misconfiguration on this end, a hardcoded property of that provider type.
// Its embedded outpost (src/outpost/proxy/auth.rs's verify_token()) checks
// the OIDC discovery document's id_token_signing_alg_values_supported for
// HS256 and, when present, verifies with the provider's own client_secret as
// the HMAC key (src/outpost/proxy/token.rs's verify_hs256()) rather than
// RS256/JWKS. This module now verifies the same way, against the same
// secret, so it accepts exactly the tokens Authentik's own outpost accepts.
//
// The X-Authentik-Meta-Jwks header Caddy forwards is attacker-forgeable
// (anything sent by the client/proxy hop can be spoofed by whatever sits in
// front of this app) and was never usable as a fetch target for that reason
// -- now moot, since HS256 verification needs no JWKS fetch at all. The
// client_secret, issuer, and audience are pinned via server-side env vars,
// set once at deploy time alongside the reverse-proxy config.
//
// All-or-nothing validation: a partially-configured deployment (e.g. someone
// set AUTHENTIK_ISSUER while rotating config but forgot the other two) must
// fail loudly at startup, not silently skip verification or 500 on the first
// request. Checked at module load so a broken deployment never serves a
// single request (AC11).
// ---------------------------------------------------------------------------
const rawClientSecret = process.env.AUTHENTIK_CLIENT_SECRET;
const rawIssuer = process.env.AUTHENTIK_ISSUER;
const rawAudience = process.env.AUTHENTIK_AUDIENCE;

const setCount = [rawClientSecret, rawIssuer, rawAudience].filter(
  (value) => value !== undefined && value !== '',
).length;

if (setCount !== 0 && setCount !== 3) {
  throw new Error(
    'Forward-auth env misconfigured: AUTHENTIK_CLIENT_SECRET, AUTHENTIK_ISSUER, and ' +
      'AUTHENTIK_AUDIENCE must be either all set or all unset (got ' +
      `${setCount}/3 set). Partial config would silently disable or break JWT ` +
      'verification -- refusing to start.',
  );
}

// Undefined when forward-auth is not configured for this deployment (all
// three env vars unset), non-undefined and mutually consistent otherwise
// (enforced by the all-or-nothing check above). Only consumed within this
// module (by verifyAuthentikJwt below) -- not exported, since nothing
// outside this file needs them (test files define their own local mock
// values rather than importing these).
const AUTHENTIK_CLIENT_SECRET = rawClientSecret;
const AUTHENTIK_ISSUER = rawIssuer;
const AUTHENTIK_AUDIENCE = rawAudience;

// ---------------------------------------------------------------------------
// Lazily-initialized, module-level HMAC key.
//
// jose's jwtVerify wants the HS256 key as raw bytes, not the secret string
// directly -- encode once and reuse across requests/invocations rather than
// re-encoding the same string on every call (AC10).
// ---------------------------------------------------------------------------
let hmacKey: Uint8Array | undefined;

/**
 * Return the module-level cached HMAC verification key, deriving it on first
 * call from AUTHENTIK_CLIENT_SECRET. Throws if forward-auth is not
 * configured -- verifyAuthentikJwt below is expected to check configuration
 * before calling this.
 */
function getHmacKey(): Uint8Array {
  if (AUTHENTIK_CLIENT_SECRET === undefined) {
    throw new Error(
      'getHmacKey() called but AUTHENTIK_CLIENT_SECRET is not configured -- ' +
        'forward-auth is disabled for this deployment.',
    );
  }
  if (hmacKey === undefined) {
    hmacKey = new TextEncoder().encode(AUTHENTIK_CLIENT_SECRET);
  }
  return hmacKey;
}

// ---------------------------------------------------------------------------
// Fail-closed verification result contract (2026-08-01 security fix).
//
// The original contract collapsed every failure mode -- forward-auth not
// configured, bad signature, expired token, wrong iss/aud, alg-confusion,
// AND "the verifier itself could not run the check" -- into a single `null`,
// and the caller (middleware.ts) treated `null` identically to "no
// credential was ever presented": pass the request through untouched. That
// conflates two very different states:
//   - No credential presented at all (no X-Authentik-Jwt header) -- a
//     legitimate, expected state for local-dev/Tailscale-LAN access that
//     never goes through Authentik's proxy. Passing through is correct here
//     because the app's own downstream tenant-session check still gates the
//     request; forward-auth simply has nothing to verify.
//   - A credential WAS presented and verification could not confirm it --
//     it is cryptographically or semantically invalid. Passing this through
//     identically to "no credential" means a misconfigured or forged
//     credential silently disables SSO identity-mapping fleet-wide while the
//     process keeps running with zero log output and zero restarts --
//     indistinguishable from "working fine" in every signal
//     `systemctl`/`journalctl` expose.
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
 * CONVENTIONS.md #18's "did-nothing rule" and level discipline).
 *
 * HS256 verification is local, synchronous HMAC over bytes already in hand
 * -- there is no network call anywhere in this function's call graph, unlike
 * the earlier RS256/JWKS design -- so there is no verifier-side-dependency
 * failure mode left to classify (no `jwks_unreachable`, no `key_not_found`
 * key-rotation window). Every remaining reason is a property of the
 * presented token itself:
 *
 * - `invalid_signature` -- signature verification failed against the
 *   provider's client_secret.
 * - `invalid_algorithm` -- header `alg` was not exactly `HS256`: covers
 *   `alg: none` and any algorithm-confusion attempt.
 * - `token_expired` -- `exp` claim in the past.
 * - `invalid_issuer` / `invalid_audience` -- `iss`/`aud` claim mismatch
 *   against the pinned `AUTHENTIK_ISSUER`/`AUTHENTIK_AUDIENCE`.
 * - `malformed_token` -- not a structurally valid compact JWS (e.g. the
 *   literal string `'not-a-jwt'`), or another claim-shape problem jose does
 *   not attribute a claim name to.
 * - `missing_email_claim` -- signature and claims verified, but the `email`
 *   claim is absent, empty, or not a string.
 * - `unknown` -- a thrown value that jose did not classify into one of its
 *   own error types (or is not even an `Error` instance). Genuinely
 *   unclassified; should be rare.
 */
export type ForwardAuthFailureReason =
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
 * pinned `algorithms: ['HS256']` option). Both are public, non-secret
 * values already visible in the token's base64 header segment, so logging
 * them is safe per CONVENTIONS.md #18's redaction deny-list. `alg` is what
 * makes an `invalid_algorithm` failure diagnosable from logs alone --
 * without it, "the alg was wrong" carries no information about *which* alg
 * actually showed up (a stray RS256/none token vs. a genuine
 * algorithm-confusion attempt look identical in the log otherwise). Returns
 * `{}` (never throws) if the token isn't even well-formed enough to have a
 * decodable header.
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
 * Any error jose didn't classify into one of its own subclasses -- or a
 * thrown value that isn't even an `Error` instance -- is bucketed as
 * `unknown`. Unlike the earlier RS256/JWKS design, HS256 verification never
 * makes a network call, so there is no longer a legitimate "the verifier's
 * own dependency is down" failure mode to fold unrecognized errors into.
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

  return 'unknown';
}

/**
 * Verify a forward-auth JWT (the one Authentik's proxy places in the
 * X-Authentik-Jwt header) against the pinned client_secret/issuer/audience
 * using HS256, and return its `email` claim.
 *
 * Never throws. Returns one of three states -- see ForwardAuthResult above:
 *   - `{ status: 'not_configured' }` when forward-auth is disabled for this
 *     deployment (all three env vars unset). No verification is attempted.
 *   - `{ status: 'verified', email }` when the token's signature, `alg`,
 *     `iss`, `aud`, and expiry all check out against the pinned
 *     client_secret, and its `email` claim is a non-empty string.
 *   - `{ status: 'invalid', reason, keyId?, alg? }` for every other case:
 *     bad signature, expired token, wrong `iss`/`aud`, a header `alg` other
 *     than exactly HS256 (`alg: none` and algorithm-confusion attempts
 *     included -- `algorithms: ['HS256']` below is what pins it), a
 *     malformed token, or a missing/empty/non-string `email` claim.
 *     `reason` is a stable ForwardAuthFailureReason; `keyId`/`alg` are the
 *     token's header fields when decodable, for logging only.
 *
 * Callers MUST NOT treat `invalid` the same as `not_configured` -- a
 * presented-but-unverifiable credential must be denied (fail closed), while
 * "not configured" means forward-auth has nothing to verify here and the
 * app's own downstream session check still applies. See middleware.ts.
 */
export async function verifyAuthentikJwt(jwt: string): Promise<ForwardAuthResult> {
  if (
    AUTHENTIK_CLIENT_SECRET === undefined ||
    AUTHENTIK_ISSUER === undefined ||
    AUTHENTIK_AUDIENCE === undefined
  ) {
    return { status: 'not_configured' };
  }

  const { kid: keyId, alg } = safeDecodeHeaderFields(jwt);

  try {
    const { payload } = await jwtVerify(jwt, getHmacKey(), {
      algorithms: ['HS256'],
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
