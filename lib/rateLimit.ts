// Basic in-memory rate limiting for authentication endpoints.
//
// Trace: requirements.md NFR -- "Authentication endpoints (signup, login)
// must apply basic rate limiting / failed-attempt throttling per IP or per
// email, to prevent brute-force credential guessing and to prevent
// CPU-exhaustion abuse (the planned password-hashing scheme is deliberately
// CPU/memory-expensive by design, making an unthrottled endpoint a
// self-inflicted DoS vector)." challenge-notes.md records this NFR as one of
// the auth-hardening gaps added specifically because it was missing from the
// original spec -- it must not be silently dropped from the implementation.
//
// In-memory only: no new dependency, no external service, consistent with
// this app's "no external services required to run it" framing
// (requirements.md Constraints) and its single-process, single-machine
// deployment model (lib/db.ts's synchronous better-sqlite3 singleton is the
// same kind of process-local state). A process restart clears all counters --
// an accepted tradeoff for "basic" throttling, not a full distributed
// rate limiter, and not something this increment's scope calls for (general
// multi-tenant rate limiting/abuse prevention is explicitly out of scope;
// this module exists only for the auth-endpoint NFR above).

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Periodic sweep so `buckets` doesn't grow unboundedly over the life of a
// long-running process -- an attacker varying the key (e.g. a different
// email per login attempt) would otherwise leak memory indefinitely. Swept
// lazily on each call rather than via setInterval, so it costs nothing when
// the endpoints aren't being hit.
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > SWEEP_INTERVAL_MS) {
      buckets.delete(key);
    }
  }
}

/**
 * Fixed-window rate limiter. Returns true if `key` is still under `limit`
 * hits within the last `windowMs` -- incrementing its counter as a side
 * effect -- or false once the window's limit has been reached (does not
 * increment further) until the window rolls over.
 *
 * Deliberately checked BEFORE any password-hashing work happens in the
 * caller (see app/api/auth/login/route.ts, app/api/auth/signup/route.ts) --
 * the whole point of the CPU-exhaustion half of the NFR is to reject over-
 * limit requests before they pay scrypt's cost, not after.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  existing.count += 1;
  return true;
}

/** Test-only: clear all rate-limit state between test cases/files. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}

/**
 * Best-effort client IP extraction for rate-limit keying. This app has no
 * universally-trustworthy reverse proxy in front of it (localhost, or bare
 * Tailscale Serve -- see lib/tailnetOrigin.ts's comments on the same
 * problem), so x-forwarded-for / x-real-ip are read on a best-effort basis
 * when present, falling back to a constant so every direct/unproxied
 * request still shares one bucket rather than being unthrottled entirely.
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

export function tooManyRequestsBody(): { error: string } {
  return { error: 'Too many attempts. Try again later.' };
}
