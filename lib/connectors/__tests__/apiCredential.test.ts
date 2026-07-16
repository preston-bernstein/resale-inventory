import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// getDecryptedCredential/rotateCredential hit real SQLite + AES-GCM crypto
// (lib/connections.ts, lib/credentialCrypto.ts) -- this module's job is the
// freshness/caching logic layered on top, not the CRUD/encryption
// underneath, so both are mocked at the '@/lib/connections' boundary
// exactly as getFreshAccessToken() imports them.
vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  rotateCredential: vi.fn(),
}));

import { getDecryptedCredential, rotateCredential } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';

const TENANT_ID = 'tenant-1';

function freshCredential(overrides: Partial<{ accessToken: string; expiresAt: number; refreshToken: string }> = {}) {
  return {
    accessToken: 'old-access-token',
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes out, well past the buffer
    refreshToken: 'old-refresh-token',
    ...overrides,
  };
}

function expiredCredential(overrides: Partial<{ accessToken: string; expiresAt: number; refreshToken: string }> = {}) {
  return {
    accessToken: 'old-access-token',
    expiresAt: Date.now() - 1000, // already expired
    refreshToken: 'old-refresh-token',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getDecryptedCredential).mockReset();
  vi.mocked(rotateCredential).mockReset();
  // Each getFreshAccessToken() call uses a fresh connectionId per test
  // (below) so the module-level in-memory cache never leaks state between
  // tests -- except test 3, which deliberately exercises the cache within a
  // single test.
});

describe('getFreshAccessToken', () => {
  it('calls exchangeFn and persists the new token via rotateCredential when the stored token is expired', async () => {
    const connectionId = 'expired-conn';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredCredential());
    vi.mocked(rotateCredential).mockReturnValue(null);

    const exchangeFn = vi.fn().mockResolvedValue({
      accessToken: 'new-access-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: 'new-refresh-token',
    });

    const token = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);

    expect(exchangeFn).toHaveBeenCalledTimes(1);
    expect(exchangeFn).toHaveBeenCalledWith('old-refresh-token');
    expect(token).toBe('new-access-token');

    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(rotateCredential).toHaveBeenCalledWith(
      TENANT_ID,
      connectionId,
      expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }),
    );
  });

  it('does not call exchangeFn when the stored token is not expired', async () => {
    const connectionId = 'fresh-conn';
    vi.mocked(getDecryptedCredential).mockReturnValue(freshCredential());

    const exchangeFn = vi.fn();

    const token = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);

    expect(exchangeFn).not.toHaveBeenCalled();
    expect(rotateCredential).not.toHaveBeenCalled();
    expect(token).toBe('old-access-token');
  });

  it('serves the second of two back-to-back calls from the in-memory cache without re-decrypting', async () => {
    const connectionId = 'cached-conn';
    vi.mocked(getDecryptedCredential).mockReturnValue(freshCredential());

    const exchangeFn = vi.fn();

    const first = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
    const second = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);

    expect(first).toBe('old-access-token');
    expect(second).toBe('old-access-token');
    expect(getDecryptedCredential).toHaveBeenCalledTimes(1);
    expect(exchangeFn).not.toHaveBeenCalled();
  });

  it('after a refresh, immediately serves the NEXT call from the freshly-repopulated cache (not a stale/empty entry)', async () => {
    const connectionId = 'post-refresh-cache-conn';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredCredential());
    vi.mocked(rotateCredential).mockReturnValue(null);

    const exchangeFn = vi.fn().mockResolvedValue({
      accessToken: 'brand-new-access-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: 'brand-new-refresh-token',
    });

    const first = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
    expect(first).toBe('brand-new-access-token');

    vi.mocked(getDecryptedCredential).mockClear();
    exchangeFn.mockClear();

    const second = await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);

    expect(second).toBe('brand-new-access-token');
    expect(getDecryptedCredential).not.toHaveBeenCalled();
    expect(exchangeFn).not.toHaveBeenCalled();
  });

  describe('isStoredTokenCredential shape validation (via the thrown error on a malformed stored credential)', () => {
    const connectionId = 'malformed-conn';

    async function expectShapeRejection(storedValue: unknown) {
      vi.mocked(getDecryptedCredential).mockReturnValue(storedValue);
      const exchangeFn = vi.fn();

      await expect(getFreshAccessToken(TENANT_ID, connectionId, exchangeFn)).rejects.toThrow(
        `Connection ${connectionId} does not hold a token-shaped credential ` +
          `({accessToken, expiresAt, refreshToken}) -- cannot get a fresh access token for it`,
      );
      expect(exchangeFn).not.toHaveBeenCalled();
    }

    it('rejects null', async () => {
      await expectShapeRejection(null);
    });

    it('rejects a bare string (not an object at all)', async () => {
      await expectShapeRejection('not-an-object');
    });

    it('rejects an object with a non-string accessToken', async () => {
      await expectShapeRejection({
        accessToken: 12345,
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: 'x',
      });
    });

    it('rejects an object with a non-number expiresAt', async () => {
      await expectShapeRejection({
        accessToken: 'x',
        expiresAt: 'not-a-number',
        refreshToken: 'x',
      });
    });

    it('rejects an object with a non-string refreshToken', async () => {
      await expectShapeRejection({
        accessToken: 'x',
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshToken: 999,
      });
    });

    it('rejects an object missing refreshToken entirely', async () => {
      await expectShapeRejection({
        accessToken: 'x',
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    });

    // A function is typeof 'function', not 'object' -- the shape guard's
    // leading `typeof value === 'object'` conjunct must independently
    // reject it, even when every field the rest of the guard checks for is
    // otherwise present and correctly typed. A mutant that bypasses (or
    // widens) that leading typeof check would instead accept this, since
    // every other conjunct genuinely passes.
    it('rejects a function value even when it has correctly-typed accessToken/expiresAt/refreshToken properties attached', async () => {
      const weird = (() => {}) as unknown as {
        accessToken: string;
        expiresAt: number;
        refreshToken: string;
      };
      weird.accessToken = 'attached';
      weird.expiresAt = Date.now() + 10 * 60 * 1000;
      weird.refreshToken = 'attached-refresh';

      await expectShapeRejection(weird);
    });

    it('accepts a genuinely well-shaped credential (control case for the rejections above)', async () => {
      vi.mocked(getDecryptedCredential).mockReturnValue(freshCredential());
      const exchangeFn = vi.fn();

      await expect(
        getFreshAccessToken(TENANT_ID, 'well-shaped-conn', exchangeFn),
      ).resolves.toBe('old-access-token');
    });
  });

  describe('cache TTL and expiry-buffer boundaries (fake timers for exact control)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('CACHE_TTL_MS boundary: serves from cache just under the 60s TTL, but NOT at exactly 60s (falls through and re-decrypts)', async () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      const connectionId = 'ttl-boundary-conn';
      // expiresAt is far out so only the TTL conjunct (not the buffer
      // conjunct) can be responsible for a cache miss in this test.
      vi.mocked(getDecryptedCredential).mockReturnValue(
        freshCredential({ expiresAt: t0 + 60 * 60 * 1000 }),
      );
      const exchangeFn = vi.fn();

      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn); // populates cache at t0
      vi.mocked(getDecryptedCredential).mockClear();

      // Just under the 60_000ms TTL -- must still be served from cache.
      vi.setSystemTime(t0 + 59_999);
      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
      expect(getDecryptedCredential).not.toHaveBeenCalled();

      // Exactly at the 60_000ms TTL -- the check is strictly `<`, so this
      // must be a cache MISS (falls through and re-decrypts).
      vi.setSystemTime(t0 + 60_000);
      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
      expect(getDecryptedCredential).toHaveBeenCalledTimes(1);
    });

    it('expiry-buffer boundary (cache read path): serves from cache just under the 60s buffer, but NOT at exactly the buffer (falls through)', async () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      const connectionId = 'buffer-boundary-conn';
      // expiresAt fixed at t0+90_000 -- 90s after caching. The TTL window
      // (60s) is wide enough to still be a cache hit at both read times
      // below, isolating the buffer conjunct as the only thing that can
      // cause a miss.
      vi.mocked(getDecryptedCredential).mockReturnValue(
        freshCredential({ expiresAt: t0 + 90_000 }),
      );
      // The cache-miss branch also re-checks freshness against the SAME
      // buffer (line 94) -- at the read times used below, the freshly
      // re-decrypted token is itself within the buffer too, so it falls
      // through all the way to a real refresh. exchangeFn needs a
      // resolved value so that path doesn't crash.
      const exchangeFn = vi.fn().mockResolvedValue({
        accessToken: 're-decrypted-refresh-token',
        expiresAt: t0 + 10 * 60 * 1000,
        refreshToken: 'r2',
      });

      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn); // caches at t0
      vi.mocked(getDecryptedCredential).mockClear();

      // At now = t0+29_999: expiresAt(90_000) > now+buffer(89_999) -- true,
      // still fresh enough to serve from cache.
      vi.setSystemTime(t0 + 29_999);
      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
      expect(getDecryptedCredential).not.toHaveBeenCalled();

      // At now = t0+30_000: expiresAt(90_000) > now+buffer(90_000) -- FALSE
      // (equal, not greater) -- must fall through and re-decrypt.
      vi.setSystemTime(t0 + 30_000);
      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
      expect(getDecryptedCredential).toHaveBeenCalledTimes(1);
    });

    it('expiry-buffer sign: a cached token inside the buffer window (but still technically in the future) must NOT be served from cache', async () => {
      // Regression guard for an operator-sign mistake (`now + BUFFER`
      // silently becoming `now - BUFFER`, which would treat a token that
      // expires in the next 60s as if it had 60s+ of extra headroom).
      vi.useFakeTimers();
      const t0 = Date.now();
      const connectionId = 'buffer-sign-conn';
      vi.mocked(getDecryptedCredential).mockReturnValue(
        freshCredential({ expiresAt: t0 + 90_000 }),
      );
      const exchangeFn = vi.fn().mockResolvedValue({
        accessToken: 're-decrypted-refresh-token-2',
        expiresAt: t0 + 10 * 60 * 1000,
        refreshToken: 'r3',
      });

      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn); // caches at t0
      vi.mocked(getDecryptedCredential).mockClear();

      // now = t0+40_000: expiresAt(90_000) is only 50_000ms away -- inside
      // the 60_000ms buffer, so this must be treated as a cache miss.
      vi.setSystemTime(t0 + 40_000);
      await getFreshAccessToken(TENANT_ID, connectionId, exchangeFn);
      expect(getDecryptedCredential).toHaveBeenCalledTimes(1);
    });

    it('freshly-decrypted (non-cached) token expiry boundary: exactly at the buffer triggers a refresh; one ms past it does not', async () => {
      vi.useFakeTimers();
      const t0 = Date.now();
      const exchangeFn = vi.fn().mockResolvedValue({
        accessToken: 'refreshed-token',
        expiresAt: t0 + 60 * 60 * 1000,
        refreshToken: 'refreshed-refresh-token',
      });

      // Exactly at the buffer boundary: stored.expiresAt === now + BUFFER
      // -- the check is strictly `>`, so this must be treated as expired
      // and trigger a refresh.
      vi.mocked(getDecryptedCredential).mockReturnValue(
        freshCredential({ expiresAt: t0 + 60_000 }),
      );
      const tokenAtBoundary = await getFreshAccessToken(TENANT_ID, 'expiry-at-boundary', exchangeFn);
      expect(exchangeFn).toHaveBeenCalledTimes(1);
      expect(tokenAtBoundary).toBe('refreshed-token');

      exchangeFn.mockClear();

      // One ms past the boundary: must be treated as still-fresh, no
      // refresh call.
      vi.mocked(getDecryptedCredential).mockReturnValue(
        freshCredential({ expiresAt: t0 + 60_001 }),
      );
      const tokenPastBoundary = await getFreshAccessToken(
        TENANT_ID,
        'expiry-past-boundary',
        exchangeFn,
      );
      expect(exchangeFn).not.toHaveBeenCalled();
      expect(tokenPastBoundary).toBe('old-access-token');
    });
  });
});
