import { describe, it, expect, vi } from 'vitest';
import { CONNECTION_ID, FAKE_SECRET_TOKEN, TENANT_ID, baseInput } from './etsy.fixtures';
import type { ListingInput } from '../types';
import { recordSuspensionSignal } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';
import { apiFetch } from '../apiFetch';
import { createListing, updateListing, markSold, delist } from '../etsy';
import {
  ConnectorNotConfiguredError,
  ConnectorPlatformError,
  UnsupportedCategoryError,
} from '../types';

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
});

describe('createListing', () => {
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
});

describe('createListing', () => {
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
});

describe('createListing', () => {
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
});

describe('createListing', () => {
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

describe('createListing', () => {
  it('throws UnsupportedCategoryError for category "electronics" before any connector logic runs (FR15/AC9) -- Etsy is book/clothing only', async () => {
    const input = baseInput({
      category: 'electronics',
      details: {
        device_type: 'laptop',
        brand: 'Apple',
        model: 'MacBook Pro',
        processor: 'M2',
        ram_gb: 16,
        storage_gb: 512,
        screen_size_in: 14,
        battery_health_pct: 92,
        battery_cycle_count: 50,
        condition: 'Excellent',
      } as unknown as ListingInput['details'],
    });

    await expect(createListing(input)).rejects.toBeInstanceOf(UnsupportedCategoryError);
    // Category rejection is createListing's first statement -- no OAuth
    // token refresh or apiFetch call should ever happen for a rejected
    // category.
    expect(getFreshAccessToken).not.toHaveBeenCalled();
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
});

describe('updateListing', () => {
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
});

describe('updateListing', () => {
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
});

describe('markSold / delist', () => {
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
});

describe('markSold / delist', () => {
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
});

describe('markSold / delist', () => {
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
