import { describe, it, expect, vi } from 'vitest';
import { CONNECTION_ID, FAKE_SECRET_TOKEN, TENANT_ID, baseInput } from './etsy.fixtures';
import { getDecryptedCredential, recordSuspensionSignal } from '@/lib/connections';
import { apiFetch } from '../apiFetch';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  isEtsySuspensionSignal,
  etsyConnector,
} from '../etsy';
import { ConnectorPlatformError } from '../types';

describe('getEtsyShopId guard (shop_id_unresolved)', () => {
  it('throws shop_id_unresolved and never calls apiFetch when the stored credential is null', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue(null);

    const err = await createListing(baseInput()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'shop_id_unresolved', platform: 'etsy' });
    expect((err as ConnectorPlatformError).message).toContain(CONNECTION_ID);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws shop_id_unresolved when the stored credential has no shopId field', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({});

    await expect(createListing(baseInput())).rejects.toMatchObject({
      code: 'shop_id_unresolved',
    });
  });

  it('throws shop_id_unresolved when shopId is an empty string', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({ shopId: '' });

    await expect(createListing(baseInput())).rejects.toMatchObject({
      code: 'shop_id_unresolved',
    });
  });

  it('throws shop_id_unresolved when shopId is present but not a string (e.g. a number)', async () => {
    vi.mocked(getDecryptedCredential).mockReturnValue({ shopId: 12345 });

    await expect(createListing(baseInput())).rejects.toMatchObject({
      code: 'shop_id_unresolved',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('checkConnectionHealth', () => {
  it('returns {healthy:true} on a mocked successful response, hitting the exact shop-info GET URL', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { shop_id: 'shop-123' },
    });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ healthy: true });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.etsy.com/v3/application/shops/shop-123');
    expect(options?.method).toBe('GET');
    expect(options?.headers).toEqual({
      'x-api-key': 'test-etsy-api-key',
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
    });
  });

  it('returns {healthy:false, ...} on a mocked failure, without throwing, with a status-specific detail message', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error' },
    });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).toBeDefined();
    // Pins the actual detail wording (and status interpolation), not just
    // "some string came back" -- kills a mutant that empties the message.
    expect(result.detail).toContain('500');
    expect(result.detail).toContain('Etsy shop health check failed');
  });

  it('returns {healthy:false} instead of throwing when apiFetch itself rejects (e.g. timeout), carrying the original error text', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('timeout'));

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    // errorMessage(err) must actually extract err.message, not swallow it.
    expect(result.detail).toContain('timeout');
  });
});

describe('checkConnectionHealth', () => {
  it('returns {healthy:false} (never throws) when ETSY_API_KEY is missing -- requireEnv is inside the try/catch here', async () => {
    delete process.env.ETSY_API_KEY;

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('records a suspension signal and scrubs the access token out of both the reason and the detail on a 403', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: `account suspended, last token was ${FAKE_SECRET_TOKEN}` },
    });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).not.toContain(FAKE_SECRET_TOKEN);
    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('scrubs the access token out of the detail when the shop-info request itself throws (network error)', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error(`network failure, last known token ${FAKE_SECRET_TOKEN}`));

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).not.toContain(FAKE_SECRET_TOKEN);
  });
});

describe('suspension classification', () => {
  it('isEtsySuspensionSignal classifies a 403 + suspension-shaped body as suspension', () => {
    expect(isEtsySuspensionSignal(403, { error: 'shop is inactive' })).toBe(true);
    expect(isEtsySuspensionSignal(403, { error_code: 'unauthorized_shop' })).toBe(true);
  });

  it('isEtsySuspensionSignal does NOT classify a plain 401 as suspension', () => {
    expect(isEtsySuspensionSignal(401, { error: 'invalid_token' })).toBe(false);
  });

  it('isEtsySuspensionSignal does NOT classify 5xx/429 as suspension', () => {
    expect(isEtsySuspensionSignal(500, { error: 'shop is inactive' })).toBe(false);
    expect(isEtsySuspensionSignal(429, { error: 'shop is inactive' })).toBe(false);
  });

  it('isEtsySuspensionSignal handles a plain string body (not just an object)', () => {
    expect(isEtsySuspensionSignal(403, 'shop is inactive')).toBe(true);
    expect(isEtsySuspensionSignal(403, 'nothing relevant here')).toBe(false);
  });

  it('isEtsySuspensionSignal returns false, without throwing, for a null body (typeof null === "object" trap)', () => {
    expect(() => isEtsySuspensionSignal(403, null)).not.toThrow();
    expect(isEtsySuspensionSignal(403, null)).toBe(false);
  });

  it('isEtsySuspensionSignal returns false for a non-string, non-object body (e.g. a number)', () => {
    expect(isEtsySuspensionSignal(403, 12345)).toBe(false);
  });

  it('extractErrorText joins multiple body fields with a space, not concatenated -- a two-word pattern split across fields must still match', () => {
    // "account" + "suspended" only forms the "account suspended" pattern if
    // joined with a space; joined with "" it would read "accountsuspended"
    // and NOT match, so this pins the join(' ') separator specifically.
    expect(isEtsySuspensionSignal(403, { error: 'account', message: 'suspended' })).toBe(true);
  });
});

describe('suspension classification', () => {
  it('a mocked suspension-shaped 403 response (unauthorized_shop) triggers exactly one recordSuspensionSignal call with the specific classified reason, credential-free', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error_code: 'unauthorized_shop', message: 'shop is inactive' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toThrow(
      ConnectorPlatformError,
    );

    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [tenantArg, connectionArg, reasonArg, statusArg] = vi.mocked(recordSuspensionSignal).mock
      .calls[0];
    expect(tenantArg).toBe(TENANT_ID);
    expect(connectionArg).toBe(CONNECTION_ID);
    expect(statusArg).toBe('suspended');
    // unauthorized_shop must win over the "inactive" text also present in
    // the body -- pins the branch order in classifySuspensionReason.
    expect(reasonArg).toBe('etsy_403_unauthorized_shop');
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
    expect(reasonArg).not.toContain('test-etsy-api-key');
    expect(reasonArg).not.toContain('test-etsy-shared-secret');
  });

  it('classifies a 403 mentioning only "inactive" (no unauthorized_shop/suspend) as etsy_403_shop_inactive', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'shop_inactive' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toThrow(
      ConnectorPlatformError,
    );

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('etsy_403_shop_inactive');
  });
});

describe('suspension classification', () => {
  it('classifies a 403 mentioning only "suspend" (no unauthorized_shop/inactive) as etsy_403_account_suspended', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'account_suspended' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toThrow(
      ConnectorPlatformError,
    );

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('etsy_403_account_suspended');
  });

  it('classifies a suspension-shaped 403 with none of the specific keywords as the etsy_403_suspected_suspension fallback', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      // Matches SUSPENSION_INDICATOR_PATTERNS via "seller account is
      // disabled", but that phrase contains none of "unauthorized_shop",
      // "inactive", or "suspend" -- must fall through to the generic code.
      body: { error: 'seller account is disabled' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toThrow(
      ConnectorPlatformError,
    );

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('etsy_403_suspected_suspension');
  });
});

describe('suspension classification', () => {
  it('a mocked transient error (500) does NOT trigger recordSuspensionSignal, and the thrown message actually includes the stringified body', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal server error' },
    });

    let thrown: unknown;
    try {
      await updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    // safeStringify(body) must actually run -- kills a mutant that guts it
    // to return undefined, which would silently drop this from the message.
    expect((thrown as ConnectorPlatformError).message).toContain('internal server error');
    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });

  it('a mocked timeout (apiFetch rejects) does NOT trigger recordSuspensionSignal', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('request timed out'));

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toThrow();

    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });
});

describe('secret scrubbing in thrown errors', () => {
  it('never leaks the seeded fake access token into a ConnectorPlatformError message', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: `internal error, token was ${FAKE_SECRET_TOKEN}` },
    });

    let thrown: unknown;
    try {
      await updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    const message = (thrown as ConnectorPlatformError).message;
    expect(message).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('never leaks ETSY_API_KEY/ETSY_SHARED_SECRET env values into a thrown error message', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error, key was test-etsy-api-key' },
    });

    let thrown: unknown;
    try {
      await updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    const message = (thrown as ConnectorPlatformError).message;
    expect(message).not.toContain('test-etsy-api-key');
    expect(message).not.toContain('test-etsy-shared-secret');
  });
});

describe('etsyConnector export shape', () => {
  it('exposes all 5 Connector methods', () => {
    expect(etsyConnector).toMatchObject({
      createListing,
      updateListing,
      markSold,
      delist,
      checkConnectionHealth,
    });
    expect(Object.keys(etsyConnector).sort()).toEqual(
      ['checkConnectionHealth', 'createListing', 'delist', 'markSold', 'updateListing'].sort(),
    );
  });
});
