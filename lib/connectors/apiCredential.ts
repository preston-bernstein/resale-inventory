import { getDecryptedCredential, rotateCredential } from '@/lib/connections';

// Access-token freshness for connector API calls (eBay, Etsy, etc.) built on
// top of the generic platform_connections CRUD in lib/connections.ts.
//
// Storage convention: getDecryptedCredential()/rotateCredential() both deal
// in `unknown` that must be a plain JSON object (lib/connections.ts's
// assertValidCredentialShape rejects strings/arrays/null at the CRUD layer).
// There is no existing token-shaped credential convention elsewhere in this
// codebase to match (connectors/ebay.ts and friends are still `// stub`), so
// this file defines one: the stored object is
//   { accessToken: string, expiresAt: number, refreshToken: string }
// with expiresAt as epoch milliseconds. Any other stored shape (or a plain
// string) means the connection wasn't provisioned by this module and is a
// hard error rather than a silent misread.

interface StoredTokenCredential {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

function isStoredTokenCredential(value: unknown): value is StoredTokenCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).accessToken === 'string' &&
    typeof (value as Record<string, unknown>).expiresAt === 'number' &&
    typeof (value as Record<string, unknown>).refreshToken === 'string'
  );
}

// Tokens within this many ms of expiry are treated as already-expired, so a
// caller never walks away with a token that dies mid-flight to the platform
// API.
const EXPIRY_BUFFER_MS = 60_000;

// Tokens read from the in-memory cache within this many ms of being cached
// are served without re-decrypting -- purely to avoid redundant
// decryptCredential() calls on back-to-back reads for the same connection,
// never a way to serve a token past its real expiresAt (that check always
// happens against the cached expiresAt too).
const CACHE_TTL_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  cachedAt: number;
}

// Module-level, process-lifetime cache keyed by connectionId. Deliberately
// not tenant-scoped in the key: connectionId is already a UUID unique across
// tenants (it's the platform_connections primary key), so there's no
// cross-tenant collision risk in using it alone.
const tokenCache = new Map<string, CachedToken>();

/**
 * Return a valid (non-expired, per EXPIRY_BUFFER_MS) access token for the
 * given tenant's connection, refreshing it via exchangeFn if the stored
 * token is expired or near-expiry.
 *
 * Fast path: if the in-memory cache has an entry for connectionId cached
 * within the last CACHE_TTL_MS AND that entry's expiresAt is still fresh,
 * return it directly -- no getDecryptedCredential() call. Otherwise falls
 * through to decrypting the stored credential and, if needed, exchanging
 * the refresh token and persisting the result via rotateCredential(), which
 * also repopulates the cache with the new token.
 */
export async function getFreshAccessToken(
  tenantId: string,
  connectionId: string,
  exchangeFn: (refreshToken: string) => Promise<{
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
  }>,
): Promise<string> {
  const now = Date.now();

  const cached = tokenCache.get(connectionId);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS && cached.expiresAt > now + EXPIRY_BUFFER_MS) {
    return cached.accessToken;
  }

  const stored = getDecryptedCredential(tenantId, connectionId);
  if (!isStoredTokenCredential(stored)) {
    throw new Error(
      `Connection ${connectionId} does not hold a token-shaped credential ` +
        `({accessToken, expiresAt, refreshToken}) -- cannot get a fresh access token for it`,
    );
  }

  if (stored.expiresAt > now + EXPIRY_BUFFER_MS) {
    tokenCache.set(connectionId, {
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      refreshToken: stored.refreshToken,
      cachedAt: now,
    });
    return stored.accessToken;
  }

  // Expired or near-expiry: exchange the refresh token for a new access
  // token, then persist immediately so the rotated credential survives past
  // this process.
  const exchanged = await exchangeFn(stored.refreshToken);

  const newCredential: StoredTokenCredential = {
    accessToken: exchanged.accessToken,
    expiresAt: exchanged.expiresAt,
    // Platforms don't always rotate the refresh token itself on every
    // exchange -- fall back to the existing one when exchangeFn doesn't
    // return a new one.
    refreshToken: exchanged.refreshToken ?? stored.refreshToken,
  };

  // Invalidate first: if rotateCredential() throws, a stale cache entry
  // must not linger and get served as if it were still good.
  tokenCache.delete(connectionId);
  rotateCredential(tenantId, connectionId, newCredential);

  tokenCache.set(connectionId, {
    accessToken: newCredential.accessToken,
    expiresAt: newCredential.expiresAt,
    refreshToken: newCredential.refreshToken,
    cachedAt: Date.now(),
  });

  return newCredential.accessToken;
}
