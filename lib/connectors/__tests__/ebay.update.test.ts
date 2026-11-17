import { describe, it, expect, vi } from 'vitest';
import {
  CONNECTION_ID,
  FAKE_SECRET_TOKEN,
  TENANT_ID,
  baseInput,
  captureThrown,
} from './ebay.fixtures';
import { recordSuspensionSignal } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';
import { apiFetch } from '../apiFetch';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  isEbaySuspensionSignal,
  ebayConnector,
} from '../ebay';
import { ConnectorPlatformError, ConnectorNotConfiguredError } from '../types';

describe('updateListing', () => {
  it('scrubs the access token out of the thrown error message at each of the 3 failing steps (GET offer / inventory PUT / offer PUT)', async () => {
    // GET offer failure with the token echoed back.
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
    });
    const thrown1 = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' }));
    expect((thrown1 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);

    // Inventory PUT failure with the token echoed back.
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
      });
    const thrown2 = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' }));
    expect((thrown2 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);

    // Offer PUT failure with the token echoed back.
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
      });
    const thrown3 = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 999 }));
    expect((thrown3 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);
  });
});

describe('markSold / delist', () => {
  it('markSold succeeds against a mocked withdraw response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: {} });

    const result = await markSold('offer-abc', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: true });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc/withdraw');
    const body = options?.body as { reason: string };
    expect(body.reason).toBeTruthy();
  });

  it('markSold returns {ok:false, reason:"not_found"} for a mocked 404, not a throw', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 404, ok: false, body: { errors: [{ message: 'not found' }] } });

    const result = await markSold('gone', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('delist succeeds against a mocked withdraw response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: {} });

    const result = await delist('offer-abc', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: true });
  });

  it('delist returns {ok:false, reason:"not_found"} for a mocked 404, not a throw', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 404, ok: false, body: { errors: [{ message: 'not found' }] } });

    const result = await delist('gone', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('markSold / delist', () => {
  it('markSold sends the exact withdraw request: POST, {reason:"NOT_AVAILABLE"} body, Bearer + Content-Language headers', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: {} });

    await markSold('offer-abc', TENANT_ID, CONNECTION_ID);

    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc/withdraw');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual({ Authorization: `Bearer ${FAKE_SECRET_TOKEN}`, 'Content-Language': 'en-US' });
    expect(options?.body).toEqual({ reason: 'NOT_AVAILABLE' });
  });

  it('markSold throws mark_sold_<status> (a distinct opCode from delist) on a non-not-found failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    const thrown = await captureThrown(() => markSold('offer-abc', TENANT_ID, CONNECTION_ID));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('mark_sold_500');
  });

  it('delist sends the same body {reason:"NOT_AVAILABLE"} as markSold, and throws delist_<status> (a distinct opCode) on failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: {} });
    await delist('offer-abc', TENANT_ID, CONNECTION_ID);
    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(options?.body).toEqual({ reason: 'NOT_AVAILABLE' });

    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    const thrown = await captureThrown(() => delist('offer-abc', TENANT_ID, CONNECTION_ID));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('delist_500');
  });
});

describe('markSold / delist', () => {
  it('isNotFoundResponse recognizes text-based not-found signals (invalid sku/offer, does not exist) even on a non-404 status', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 400, ok: false, body: { errors: [{ message: 'Invalid offer identifier' }] } });
    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).resolves.toEqual({ ok: false, reason: 'not_found' });

    vi.mocked(apiFetch).mockResolvedValue({ status: 400, ok: false, body: { errors: [{ message: 'The requested resource does not exist' }] } });
    await expect(delist('offer-abc', TENANT_ID, CONNECTION_ID)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('checkConnectionHealth', () => {
  it('returns {healthy:true} on a mocked successful response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: { inventoryItems: [] } });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ healthy: true });
  });

  it('returns {healthy:false, ...} on a mocked failure, without throwing', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).toBeDefined();
  });

  it('returns {healthy:false} instead of throwing when apiFetch itself rejects (e.g. timeout)', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('timeout'));

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
  });

  it('returns {healthy:false} instead of throwing when access-token retrieval fails (e.g. missing credentials)', async () => {
    vi.mocked(getFreshAccessToken).mockRejectedValue(
      new ConnectorNotConfiguredError('ebay', 'EBAY_SANDBOX_CLIENT_ID'),
    );

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('sends the exact GET request (URL, method, Bearer header) to the inventory_item list endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: { inventoryItems: [] } });

    await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?limit=1');
    expect(options?.method).toBe('GET');
    expect(options?.headers).toEqual({ Authorization: `Bearer ${FAKE_SECRET_TOKEN}` });
  });
});

describe('checkConnectionHealth', () => {
  it('the returned detail string includes the exact failing status code', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 503, ok: false, body: { errors: [{ message: 'unavailable' }] } });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.detail).toContain('503');
  });

  it('handles a non-Error rejection from apiFetch (e.g. a plain string) without throwing, surfacing it via String(err)', async () => {
    vi.mocked(apiFetch).mockRejectedValue('raw string failure, not an Error instance');

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).toContain('raw string failure');
  });

  it('scrubs the access token out of the detail string when apiFetch rejects with an Error whose message echoes the token', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error(`connection reset, token was ${FAKE_SECRET_TOKEN}`));

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).not.toContain(FAKE_SECRET_TOKEN);
  });
});

describe('suspension classification', () => {
  it('isEbaySuspensionSignal classifies a 403 + suspension-shaped body as suspension', () => {
    expect(isEbaySuspensionSignal(403, { errors: [{ message: 'seller account is suspended' }] })).toBe(true);
    expect(isEbaySuspensionSignal(403, { errors: [{ message: 'account is restricted' }] })).toBe(true);
  });

  it('isEbaySuspensionSignal does NOT classify a plain 401 (expired token) as suspension', () => {
    expect(isEbaySuspensionSignal(401, { errors: [{ message: 'invalid_token' }] })).toBe(false);
  });

  it('isEbaySuspensionSignal does NOT classify 5xx/429/timeout-shaped responses as suspension', () => {
    expect(isEbaySuspensionSignal(500, { errors: [{ message: 'seller account is suspended' }] })).toBe(false);
    expect(isEbaySuspensionSignal(429, { errors: [{ message: 'seller account is suspended' }] })).toBe(false);
    expect(isEbaySuspensionSignal(503, { errors: [{ message: 'seller account is suspended' }] })).toBe(false);
  });

  it('a mocked suspension-shaped 403 response triggers exactly one recordSuspensionSignal call with a scrubbed reason', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { errors: [{ message: `seller account is suspended, token was ${FAKE_SECRET_TOKEN}` }] },
    });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [tenantArg, connectionArg, reasonArg, statusArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(tenantArg).toBe(TENANT_ID);
    expect(connectionArg).toBe(CONNECTION_ID);
    expect(statusArg).toBe('suspended');
    expect(reasonArg).toBe('ebay_403_account_suspended');
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('a mocked transient error (500) does NOT trigger recordSuspensionSignal', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: { errors: [{ message: 'internal server error' }] } });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });
});

describe('suspension classification', () => {
  it('a mocked rate-limit error (429) does NOT trigger recordSuspensionSignal', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 429, ok: false, body: { errors: [{ message: 'rate limited' }] } });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });

  it('a mocked timeout (apiFetch rejects) does NOT trigger recordSuspensionSignal', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('request timed out'));

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow();

    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });

  it('isEbaySuspensionSignal classifies every documented suspension indicator phrase as suspension', () => {
    const patterns = [
      'account is suspended',
      'account_suspended',
      'seller account is suspended',
      'seller account has been suspended',
      'not eligible to sell',
      'account is restricted',
      'account_restricted',
      'not eligible to list',
      'selling privileges',
      'selling_privileges_revoked',
    ];
    for (const phrase of patterns) {
      expect(isEbaySuspensionSignal(403, { message: `Some prefix text. ${phrase}. Some suffix text.` })).toBe(true);
    }
  });

  it('isEbaySuspensionSignal does NOT classify a 403 whose body matches none of the suspension patterns', () => {
    expect(
      isEbaySuspensionSignal(403, { errors: [{ message: 'a validation error unrelated to account status' }] }),
    ).toBe(false);
  });

  it('isEbaySuspensionSignal handles a plain-string error body, not just an object', () => {
    expect(isEbaySuspensionSignal(403, 'seller account is suspended')).toBe(true);
    expect(isEbaySuspensionSignal(403, 'a totally unrelated plain-string error')).toBe(false);
  });
});

describe('suspension classification', () => {
  it('isEbaySuspensionSignal returns false (not a crash) for a null/undefined body', () => {
    expect(isEbaySuspensionSignal(403, null)).toBe(false);
    expect(isEbaySuspensionSignal(403, undefined)).toBe(false);
  });

  it('isEbaySuspensionSignal reads error/error_description/message on a non-array-errors object body', () => {
    expect(
      isEbaySuspensionSignal(403, { error: 'access_denied', error_description: 'account is restricted' }),
    ).toBe(true);
  });

  it('isEbaySuspensionSignal joins errorId/domain/category/message/longMessage from the errors array (numeric errorId included)', () => {
    expect(
      isEbaySuspensionSignal(403, {
        errors: [
          { errorId: 12345, domain: 'API_INVENTORY', category: 'REQUEST', longMessage: 'seller account is suspended' },
        ],
      }),
    ).toBe(true);
  });

  it('isEbaySuspensionSignal skips a null/non-object entry in the errors array instead of crashing', () => {
    expect(
      isEbaySuspensionSignal(403, { errors: [null, { message: 'seller account is suspended' }] }),
    ).toBe(true);
    expect(isEbaySuspensionSignal(403, { errors: [null, 'not-an-object-either'] })).toBe(false);
  });

  it('classifySuspensionReason (via recordSuspensionSignal) picks "account_restricted" for a "restrict"-shaped 403 body', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { errors: [{ message: 'account is restricted from selling' }] },
    });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('ebay_403_account_restricted');
  });
});

describe('suspension classification', () => {
  it('classifySuspensionReason picks "seller_ineligible" for a body mentioning "eligible" but not "restrict"/"suspend"', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { errors: [{ message: 'this seller is not eligible to sell in this category' }] },
    });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('ebay_403_seller_ineligible');
  });

  it('classifySuspensionReason falls back to "suspected_suspension" for a suspension-classified body matching none of restrict/suspend/eligible', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { errors: [{ message: 'selling privileges have been revoked' }] },
    });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('ebay_403_suspected_suspension');
  });

  it('classifySuspensionReason prefers "restricted" over "suspended" when a body mentions both (restrict checked first)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { errors: [{ message: 'account is restricted and effectively suspended' }] },
    });

    await expect(markSold('offer-abc', TENANT_ID, CONNECTION_ID)).rejects.toThrow(ConnectorPlatformError);

    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).toBe('ebay_403_account_restricted');
  });
});

describe('suspension classification', () => {
  it('falls back to String(body) in the thrown error message when the body cannot be JSON-stringified (circular reference)', async () => {
    const circular: Record<string, unknown> = { message: 'account suspended structure' };
    circular.self = circular;

    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: circular });

    const thrown = await captureThrown(() => markSold('offer-abc', TENANT_ID, CONNECTION_ID));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).message).toContain('[object Object]');
  });
});

describe('ebayConnector', () => {
  it('exposes exactly the 5 raw Connector methods, referencing the same exported functions', () => {
    expect(Object.keys(ebayConnector).sort()).toEqual(
      ['checkConnectionHealth', 'createListing', 'delist', 'markSold', 'updateListing'].sort(),
    );
    expect(ebayConnector.createListing).toBe(createListing);
    expect(ebayConnector.updateListing).toBe(updateListing);
    expect(ebayConnector.markSold).toBe(markSold);
    expect(ebayConnector.delist).toBe(delist);
    expect(ebayConnector.checkConnectionHealth).toBe(checkConnectionHealth);
  });
});

describe('secret scrubbing in thrown errors', () => {
  it('never leaks the seeded fake access token into a ConnectorPlatformError message', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { errors: [{ message: `internal error, token was ${FAKE_SECRET_TOKEN}` }] },
    });

    const thrown = await captureThrown(() => markSold('offer-abc', TENANT_ID, CONNECTION_ID));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    const message = (thrown as ConnectorPlatformError).message;
    expect(message).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('never leaks the access token into checkConnectionHealth\'s returned detail string', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { errors: [{ message: `internal error, token was ${FAKE_SECRET_TOKEN}` }] },
    });

    const result = await checkConnectionHealth(TENANT_ID, CONNECTION_ID);

    expect(result.healthy).toBe(false);
    expect(result.detail).not.toContain(FAKE_SECRET_TOKEN);
  });
});

describe('configuration errors', () => {
  it('propagates ConnectorNotConfiguredError from access-token retrieval (e.g. missing EBAY_SANDBOX_CLIENT_ID/SECRET) rather than swallowing or misclassifying it', async () => {
    vi.mocked(getFreshAccessToken).mockRejectedValue(
      new ConnectorNotConfiguredError('ebay', 'EBAY_SANDBOX_CLIENT_ID'),
    );

    await expect(createListing(baseInput())).rejects.toThrow(ConnectorNotConfiguredError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws (rather than silently defaulting to production) when EBAY_ENV is set to an unsupported value', async () => {
    process.env.EBAY_ENV = 'staging';

    await expect(createListing(baseInput())).rejects.toThrow(/staging/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
