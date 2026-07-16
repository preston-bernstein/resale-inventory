import { recordSuspensionSignal } from '@/lib/connections';
import { scrubSecrets } from './scrub';

// Small, deliberately generic helpers factored out of ebay.ts/etsy.ts (and,
// where genuinely identical, amazon.ts) after fallow's duplication audit
// flagged their near-identical error-handling/suspension-classification
// scaffolding as clone groups. Every platform-specific bit -- the actual
// suspension-phrase lists, not-found-phrase lists, per-platform error-code
// prefixes/messages, URL construction -- stays in each connector file and is
// passed in here as a parameter/callback; nothing platform-specific is baked
// into this file. See each connector's own SUSPENSION_INDICATOR_PATTERNS /
// classify*SuspensionReason / isNotFoundResponse for the platform-specific
// half of this split.

/**
 * JSON.stringify with a String(body) fallback for values it can't serialize
 * (e.g. a body containing a circular structure) -- used when building a
 * human-readable error message from an arbitrary API response body.
 * Identical across every API-tier connector; nothing platform-specific about
 * it.
 */
export function safeStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Shared shape of eBay/Etsy's best-effort suspension-classification
 * heuristic: only a 403 is ever considered a candidate (401 = likely just an
 * expired/invalid token, already handled by the refresh path; 5xx/429/
 * timeout = transient) -- and even then, only when the response's extracted
 * error text contains one of the platform's own known suspension-indicator
 * phrases. `extractErrorText`/`patterns` are supplied by the caller; this
 * function has no opinion on what a suspension looks like on any given
 * platform.
 */
export function matchesSuspensionPatterns(
  status: number,
  body: unknown,
  extractErrorText: (body: unknown) => string,
  patterns: readonly string[],
): boolean {
  if (status !== 403) {
    return false;
  }
  const text = extractErrorText(body).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * Shared shape of eBay/Etsy's "record a suspension signal if this response
 * looks like one" step: run the platform's own isSuspensionSignal check,
 * classify the reason (also platform-specific), scrub secrets out of it, and
 * persist via recordSuspensionSignal. A no-op when isSuspensionSignal
 * returns false.
 */
export async function maybeRecordSuspensionSignal(
  tenantId: string,
  connectionId: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
  isSuspensionSignal: (status: number, body: unknown) => boolean,
  classifyReason: (body: unknown) => string,
): Promise<void> {
  if (!isSuspensionSignal(status, body)) {
    return;
  }
  const reason = scrubSecrets(classifyReason(body), secrets);
  recordSuspensionSignal(tenantId, connectionId, reason, 'suspended');
}

/**
 * Shared shape of eBay/Etsy's not-found check: a literal 404 status always
 * counts; otherwise fall back to scanning the extracted error text for one
 * of the platform's own not-found-indicator phrases (both platforms
 * sometimes return a non-404 status with a "no longer exists"-shaped body).
 */
export function isNotFoundStatusOrText(
  status: number,
  body: unknown,
  extractErrorText: (body: unknown) => string,
  patterns: readonly string[],
): boolean {
  if (status === 404) {
    return true;
  }
  const text = extractErrorText(body).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

/**
 * Shared shape of every write-style connector call's result interpretation
 * (eBay's withdrawOffer/updateListing steps, Etsy's updateListing/
 * transitionDraftListingState/delist, Amazon's sendListingsWrite): a 2xx is
 * `{ok: true}`; a not-found-shaped failure is the typed
 * `{ok: false, reason: 'not_found'}` result (not-found is a normal
 * steady-state outcome, not an exception -- see plan.md); anything else runs
 * the platform's own suspension classification and throws the platform's
 * own error. All three platform-specific pieces (isNotFound/
 * recordSuspension/buildError) are supplied by the caller -- this function
 * only owns the branch order and the two typed return shapes.
 */
export async function interpretWriteResult(
  result: { status: number; ok: boolean; body: unknown },
  opts: {
    isNotFound: (status: number, body: unknown) => boolean;
    recordSuspension: () => Promise<void>;
    buildError: () => Error;
  },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  if (result.ok) {
    return { ok: true };
  }
  if (opts.isNotFound(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }
  await opts.recordSuspension();
  throw opts.buildError();
}
