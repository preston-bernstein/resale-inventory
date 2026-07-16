import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ListingInput } from '../types';

// getDecryptedCredential (used here for shop_id resolution) and
// recordSuspensionSignal are mocked at the '@/lib/connections' boundary --
// same discipline as apiCredential.test.ts mocking the CRUD/encryption
// layer underneath it.
vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  recordSuspensionSignal: vi.fn(),
}));

// getFreshAccessToken's own freshness/caching/refresh logic is covered by
// apiCredential.test.ts -- this connector's tests mock it directly so a
// test can hand back a known fake token without wiring up a real
// stored-credential/exchange round trip.
vi.mock('../apiCredential', () => ({
  getFreshAccessToken: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { getDecryptedCredential, recordSuspensionSignal } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';
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
import { ConnectorNotConfiguredError, ConnectorPlatformError } from '../types';

const TENANT_ID = 'tenant-1';
const CONNECTION_ID = 'conn-1';
const FAKE_SECRET_TOKEN = 'sekrit-access-token-xyz789';

function baseInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    itemId: 'item-1',
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    title: 'The Great Gatsby',
    priceCents: 1999,
    category: 'book',
    details: {
      isbn: '9780743273565',
      author: 'F. Scott Fitzgerald',
      publisher: 'Scribner',
      condition: 'Good',
    },
    photos: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getDecryptedCredential).mockReset();
  vi.mocked(recordSuspensionSignal).mockReset();
  vi.mocked(getFreshAccessToken).mockReset();
  vi.mocked(apiFetch).mockReset();

  process.env.ETSY_API_KEY = 'test-etsy-api-key';
  process.env.ETSY_SHARED_SECRET = 'test-etsy-shared-secret';

  vi.mocked(getDecryptedCredential).mockReturnValue({ shopId: 'shop-123' });
  vi.mocked(getFreshAccessToken).mockResolvedValue(FAKE_SECRET_TOKEN);
});

describe('createListing', () => {
  it('always sets state to "draft" in the request body, never "active", and builds the exact create payload/URL/headers', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: { listing_id: 555 },
    });

    const result = await createListing(baseInput());

    expect(result).toEqual({ externalListingId: '555' });
    expect(apiFetch).toHaveBeenCalledTimes(1);

    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    // Exact URL, not just a substring match -- pins base URL + shop-scoping.
    expect(url).toBe('https://api.etsy.com/v3/application/shops/shop-123/listings');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual({
      'x-api-key': 'test-etsy-api-key',
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
    });

    const body = options?.body as Record<string, unknown>;
    // Full body equality -- catches a mutant flipping state, dropping a
    // field, or corrupting price/description construction while a looser
    // per-field assertion would miss it.
    expect(body).toEqual({
      quantity: 1,
      title: 'The Great Gatsby',
      description: 'By F. Scott Fitzgerald\nPublisher: Scribner\nISBN: 9780743273565\nCondition: Good',
      price: 19.99,
      state: 'draft',
    });
    expect(body.state).not.toBe('active');
  });

  it('omits a missing optional book field from the description with no blank line left behind (filter(Boolean) must run)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: { listing_id: 555 },
    });

    // isbn omitted -- without filter(Boolean), the null entry still occupies
    // a slot in the array and Array.join renders it as an extra blank line
    // between Publisher and Condition.
    const input = baseInput({
      details: {
        author: 'F. Scott Fitzgerald',
        publisher: 'Scribner',
        condition: 'Good',
      } as unknown as ListingInput['details'],
    });

    await createListing(input);

    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.description).toBe('By F. Scott Fitzgerald\nPublisher: Scribner\nCondition: Good');
  });

  it('throws create_<status> and never calls recordSuspensionSignal for a non-2xx, non-403 createListing failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error' },
    });

    let thrown: unknown;
    try {
      await createListing(baseInput());
      expect.unreachable('createListing should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('create_500');
    expect((thrown as ConnectorPlatformError).platform).toBe('etsy');
    expect(recordSuspensionSignal).not.toHaveBeenCalled();
  });

  it('scrubs the access token out of both the suspension reason and the thrown error message for a 403 createListing failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: `account suspended, last token was ${FAKE_SECRET_TOKEN}` },
    });

    const err = await createListing(baseInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);

    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('throws a ConnectorPlatformError (not a raw TypeError) when the create response body is entirely missing', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: undefined,
    });

    await expect(createListing(baseInput())).rejects.toMatchObject({
      code: 'create_bad_response',
    });
  });

  it('builds the exact clothing-category description (brand/size/color/condition, blank fields omitted)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: { listing_id: 777 },
    });

    const input = baseInput({
      category: 'clothing',
      details: {
        brand: 'Levi',
        size_label: 'M',
        color: '',
        condition: 'Excellent',
      } as unknown as ListingInput['details'],
    });

    await createListing(input);

    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    // color is falsy ('') so it must be filtered out of the description
    // entirely, not rendered as "Color: ".
    expect(body.description).toBe('Brand: Levi\nSize: M\nCondition: Excellent');
  });

  it('divides priceCents by 100 (not multiplies) to build the dollar price', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: { listing_id: 555 },
    });

    await createListing(baseInput({ priceCents: 4250 }));

    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.price).toBe(42.5);
  });

  it('throws create_bad_response (not a success) when the response has no listing_id', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: {},
    });

    let thrown: unknown;
    try {
      await createListing(baseInput());
      expect.unreachable('createListing should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('create_bad_response');
  });

  it('throws create_bad_response when listing_id is explicitly null', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 201,
      ok: true,
      body: { listing_id: null },
    });

    await expect(createListing(baseInput())).rejects.toMatchObject({
      code: 'create_bad_response',
    });
  });

  it('throws ConnectorNotConfiguredError for platform "etsy" and never calls apiFetch when ETSY_API_KEY is missing', async () => {
    delete process.env.ETSY_API_KEY;

    let thrown: unknown;
    try {
      await createListing(baseInput());
      expect.unreachable('createListing should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectorNotConfiguredError);
    expect((thrown as ConnectorNotConfiguredError).platform).toBe('etsy');
    expect((thrown as ConnectorNotConfiguredError).missingVar).toBe('ETSY_API_KEY');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('updateListing', () => {
  it('never sets state to "active" in the request body, and builds the exact URL/method/headers/body', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { listing_id: 555, state: 'draft' },
    });

    const result = await updateListing('555', TENANT_ID, CONNECTION_ID, {
      title: 'New Title',
      priceCents: 2500,
    });

    expect(result).toEqual({ ok: true });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.etsy.com/v3/application/shops/shop-123/listings/555');
    expect(options?.method).toBe('PATCH');
    expect(options?.headers).toEqual({
      'x-api-key': 'test-etsy-api-key',
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
    });
    const body = options?.body as Record<string, unknown>;
    expect(body).toEqual({ state: 'draft', title: 'New Title', price: 25 });
    expect(body.state).not.toBe('active');
  });

  it('omits title/price from the patch body when not provided on the patch', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { listing_id: 555 },
    });

    await updateListing('555', TENANT_ID, CONNECTION_ID, {});

    const [, options] = vi.mocked(apiFetch).mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).toEqual({ state: 'draft' });
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('price');
  });

  it('maps a 404 response to {ok:false, reason:"not_found"} instead of throwing (status-only, unrelated body text)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 404,
      ok: false,
      // Deliberately no "not found"/"no listing"/"does not exist" phrase in
      // the body, so this only passes via the status === 404 check, not the
      // text-matching fallback -- kills a mutant that guts the status check
      // but leaves the text fallback intact.
      body: { error: 'gone' },
    });

    const result = await updateListing('does-not-exist', TENANT_ID, CONNECTION_ID, {
      title: 'x',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps a non-404 status with a "no listing" body phrase to not_found (text-fallback path)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 400,
      ok: false,
      body: { error: 'no listing exists for that id' },
    });

    const result = await updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('maps a non-404 status with a "does not exist" body phrase to not_found (text-fallback path)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 400,
      ok: false,
      body: { error: 'that listing does not exist' },
    });

    const result = await updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('does NOT map a non-404 status with unrelated body text to not_found -- throws instead', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 400,
      ok: false,
      body: { error: 'invalid price format' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toBeInstanceOf(
      ConnectorPlatformError,
    );
  });

  it('throws update_<status> as the error code on a non-404, non-suspension failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error' },
    });

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toMatchObject({
      code: 'update_500',
    });
  });

  it('throws ConnectorNotConfiguredError for platform "etsy" and never calls apiFetch when ETSY_API_KEY is missing', async () => {
    delete process.env.ETSY_API_KEY;

    await expect(updateListing('555', TENANT_ID, CONNECTION_ID, { title: 'x' })).rejects.toMatchObject({
      platform: 'etsy',
      missingVar: 'ETSY_API_KEY',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('markSold / delist', () => {
  it('markSold succeeds against a mocked draft-state listing', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { listing_id: 555, state: 'inactive' },
    });

    const result = await markSold('555', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: true });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.etsy.com/v3/application/shops/shop-123/listings/555');
    expect(options?.method).toBe('PATCH');
    expect(options?.headers).toEqual({
      'x-api-key': 'test-etsy-api-key',
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
    });
    // Exact body -- markSold's only state transition is 'inactive', never
    // 'active', and the body must carry nothing else.
    const body = options?.body as Record<string, unknown>;
    expect(body).toEqual({ state: 'inactive' });
    expect(body.state).not.toBe('active');
  });

  it('markSold returns {ok:false, reason:"not_found"} for an already-terminal/missing listing, not a throw (status-only, unrelated body text)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 404,
      ok: false,
      body: { error: 'gone' },
    });

    const result = await markSold('gone', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('markSold throws mark_sold_<status> as the error code on a non-404, non-suspension failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error' },
    });

    await expect(markSold('555', TENANT_ID, CONNECTION_ID)).rejects.toMatchObject({
      code: 'mark_sold_500',
    });
  });

  it('markSold throws ConnectorNotConfiguredError for platform "etsy" when ETSY_API_KEY is missing', async () => {
    delete process.env.ETSY_API_KEY;

    await expect(markSold('555', TENANT_ID, CONNECTION_ID)).rejects.toMatchObject({
      platform: 'etsy',
      missingVar: 'ETSY_API_KEY',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('scrubs the access token out of both the suspension reason and the thrown error message for a 403 markSold failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: `account suspended, last token was ${FAKE_SECRET_TOKEN}` },
    });

    const err = await markSold('555', TENANT_ID, CONNECTION_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);
    expect((err as ConnectorPlatformError).code).toBe('mark_sold_403');

    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
  });

  it('delist succeeds against a mocked draft-state listing, sending DELETE with no body to the exact listing URL', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 204,
      ok: true,
      body: null,
    });

    const result = await delist('555', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: true });
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.etsy.com/v3/application/shops/shop-123/listings/555');
    expect(options?.method).toBe('DELETE');
    expect(options?.headers).toEqual({
      'x-api-key': 'test-etsy-api-key',
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
    });
    expect(options).not.toHaveProperty('body');
  });

  it('delist returns {ok:false, reason:"not_found"} for a mocked 404, not a throw (status-only, unrelated body text)', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 404,
      ok: false,
      body: { error: 'gone' },
    });

    const result = await delist('gone', TENANT_ID, CONNECTION_ID);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('delist throws delist_<status> as the error code on a non-404, non-suspension failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { error: 'internal error' },
    });

    await expect(delist('555', TENANT_ID, CONNECTION_ID)).rejects.toMatchObject({
      code: 'delist_500',
    });
  });

  it('delist throws ConnectorNotConfiguredError for platform "etsy" when ETSY_API_KEY is missing', async () => {
    delete process.env.ETSY_API_KEY;

    await expect(delist('555', TENANT_ID, CONNECTION_ID)).rejects.toMatchObject({
      platform: 'etsy',
      missingVar: 'ETSY_API_KEY',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('scrubs the access token out of both the suspension reason and the thrown error message for a 403 delist failure', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: `account suspended, last token was ${FAKE_SECRET_TOKEN}` },
    });

    const err = await delist('555', TENANT_ID, CONNECTION_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);
    expect((err as ConnectorPlatformError).code).toBe('delist_403');

    expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    const [, , reasonArg] = vi.mocked(recordSuspensionSignal).mock.calls[0];
    expect(reasonArg).not.toContain(FAKE_SECRET_TOKEN);
  });
});

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
