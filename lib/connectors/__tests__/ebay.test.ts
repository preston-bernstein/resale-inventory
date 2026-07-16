import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ListingInput } from '../types';

// recordSuspensionSignal is mocked at the '@/lib/connections' boundary --
// same discipline as etsy.test.ts. ebay.ts (unlike etsy.ts) doesn't need
// getDecryptedCredential -- there's no shop_id-equivalent lookup here, the
// offerId returned by createListing carries everything subsequent calls
// need (see ebay.ts's createListing doc comment).
vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

// getFreshAccessToken's own freshness/caching/refresh logic is covered by
// apiCredential.test.ts, and ebayExchangeFn's OAuth request-shaping is
// covered by ebay.oauth.test.ts -- this file mocks getFreshAccessToken
// directly so each test can hand back a known fake token (or simulate a
// config error) without wiring up a real stored-credential/exchange round
// trip.
vi.mock('../apiCredential', () => ({
  getFreshAccessToken: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

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

const TENANT_ID = 'tenant-1';
const CONNECTION_ID = 'conn-1';
const FAKE_SECRET_TOKEN = 'sekrit-ebay-access-token-xyz789';

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

const originalEbayEnv = process.env.EBAY_ENV;

beforeEach(() => {
  vi.mocked(recordSuspensionSignal).mockReset();
  vi.mocked(getFreshAccessToken).mockReset();
  vi.mocked(apiFetch).mockReset();

  process.env.EBAY_ENV = 'sandbox';
  vi.mocked(getFreshAccessToken).mockResolvedValue(FAKE_SECRET_TOKEN);
});

afterEach(() => {
  if (originalEbayEnv === undefined) {
    delete process.env.EBAY_ENV;
  } else {
    process.env.EBAY_ENV = originalEbayEnv;
  }
});

describe('createListing', () => {
  it('makes the 3-step Create Inventory Item -> Offer -> Publish sequence and returns the offerId from the publish-confirmed flow', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} }) // PUT inventory_item
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } }) // POST offer
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } }); // POST publish

    const result = await createListing(baseInput());

    expect(result).toEqual({ externalListingId: 'offer-abc' });
    expect(apiFetch).toHaveBeenCalledTimes(3);

    const [inventoryUrl, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    expect(inventoryUrl).toContain('/sell/inventory/v1/inventory_item/');
    expect(inventoryUrl).toContain('item-1');
    expect(inventoryOptions?.method).toBe('PUT');

    const [offerUrl, offerOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(offerUrl).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer');
    expect(offerOptions?.method).toBe('POST');
    const offerBody = offerOptions?.body as Record<string, unknown>;
    // The sku sent to Create Offer must match the sku used in the
    // Create Inventory Item URL (step 1), tying the 3 steps together.
    expect(inventoryUrl).toContain(String(offerBody.sku));
    expect(offerBody.pricingSummary).toEqual({ price: { value: '19.99', currency: 'USD' } });

    const [publishUrl, publishOptions] = vi.mocked(apiFetch).mock.calls[2];
    expect(publishUrl).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc/publish');
    expect(publishOptions?.method).toBe('POST');
  });

  it('generates a unique SKU per call (containing the itemId) so repeated runs against the same item never collide', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: { offerId: 'offer-x', listingId: 'listing-x' } });

    await createListing(baseInput());
    const firstSkuUrl = vi.mocked(apiFetch).mock.calls[0][0] as string;

    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: { offerId: 'offer-y', listingId: 'listing-y' } });

    await createListing(baseInput());
    const secondSkuUrl = vi.mocked(apiFetch).mock.calls[0][0] as string;

    expect(firstSkuUrl).toContain('item-1');
    expect(secondSkuUrl).toContain('item-1');
    expect(firstSkuUrl).not.toBe(secondSkuUrl);
  });

  it('throws if the create-offer step never returns an offerId', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: {} });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).platform).toBe('ebay');
    expect((thrown as ConnectorPlatformError).code).toBe('offer_bad_response');
    expect((thrown as ConnectorPlatformError).message).toContain('did not include an offerId');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('throws if the publish step never returns a listingId, even on an ok:true response', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).platform).toBe('ebay');
    expect((thrown as ConnectorPlatformError).code).toBe('publish_bad_response');
    expect((thrown as ConnectorPlatformError).message).toContain('did not include a listingId');
  });

  it('sends the exact Create Inventory Item request body (availability, condition, product title/description) with Bearer + Content-Language headers, for a book listing', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(baseInput());

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    expect(inventoryOptions?.headers).toEqual({
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
      'Content-Language': 'en-US',
    });
    expect(inventoryOptions?.body).toEqual({
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: 'USED_GOOD',
      product: {
        title: 'The Great Gatsby',
        description: 'By F. Scott Fitzgerald\nPublisher: Scribner\nISBN: 9780743273565\nCondition: Good',
      },
    });
  });

  it('omits null book detail fields (isbn/publisher) from the description, keeping only author + condition -- no stray blank lines', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(
      baseInput({ details: { isbn: null, author: 'Jane Austen', publisher: null, condition: 'Good' } }),
    );

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { product: { description: string } };
    expect(body.product.description).toBe('By Jane Austen\nCondition: Good');
  });

  it('builds a clothing description (brand/size/color/condition) and maps an NWT condition to NEW for a clothing listing', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(
      baseInput({
        category: 'clothing',
        title: 'Vintage Jacket',
        details: {
          brand: "Levi's",
          size_label: 'M',
          color: 'Blue',
          material: null,
          gender_department: null,
          weight_oz: null,
          pit_to_pit_in: null,
          length_in: null,
          sleeve_length_in: null,
          waist_in: null,
          rise_in: null,
          inseam_in: null,
          leg_opening_in: null,
          hip_in: null,
          condition: 'NWT',
        },
      }),
    );

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { condition: string; product: { description: string } };
    expect(body.condition).toBe('NEW');
    expect(body.product.description).toBe("Brand: Levi's\nSize: M\nColor: Blue\nCondition: NWT");
  });

  it('maps a non-NWT clothing condition (e.g. EUC) to USED_GOOD and omits a null color from the description', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(
      baseInput({
        category: 'clothing',
        title: 'Worn Jeans',
        details: {
          brand: "Levi's",
          size_label: '32x30',
          color: null,
          material: null,
          gender_department: null,
          weight_oz: null,
          pit_to_pit_in: null,
          length_in: null,
          sleeve_length_in: null,
          waist_in: null,
          rise_in: null,
          inseam_in: null,
          leg_opening_in: null,
          hip_in: null,
          condition: 'EUC',
        },
      }),
    );

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { condition: string; product: { description: string } };
    expect(body.condition).toBe('USED_GOOD');
    expect(body.product.description).toBe("Brand: Levi's\nSize: 32x30\nCondition: EUC");
  });

  it('converts priceCents to the eBay price value with exact 2-decimal formatting at boundary values (1 cent, and a 4-digit-dollar price)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });
    await createListing(baseInput({ priceCents: 1 }));
    const [, offerOptions1] = vi.mocked(apiFetch).mock.calls[1];
    expect((offerOptions1?.body as { pricingSummary: unknown }).pricingSummary).toEqual({
      price: { value: '0.01', currency: 'USD' },
    });

    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-xyz' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-xyz' } });
    await createListing(baseInput({ priceCents: 123456 }));
    const [, offerOptions2] = vi.mocked(apiFetch).mock.calls[1];
    expect((offerOptions2?.body as { pricingSummary: unknown }).pricingSummary).toEqual({
      price: { value: '1234.56', currency: 'USD' },
    });
  });

  it('the SKU suffix is exactly 8 hex characters (uuidv4 sliced to 8), not the full uuid', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 200, ok: true, body: { offerId: 'offer-x', listingId: 'listing-x' } });

    await createListing(baseInput());
    const skuUrl = vi.mocked(apiFetch).mock.calls[0][0] as string;
    const match = skuUrl.match(/\/inventory_item\/item-1-([0-9a-f-]+)$/i);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^[0-9a-f]{8}$/i);
  });

  it('throws inventory_item_<status> and never proceeds to Create Offer when the Create Inventory Item step fails', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ status: 400, ok: false, body: { errors: [{ message: 'bad request' }] } });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).platform).toBe('ebay');
    expect((thrown as ConnectorPlatformError).code).toBe('inventory_item_400');
    expect((thrown as ConnectorPlatformError).message).toContain('inventory_item_400');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('throws offer_<status> and never proceeds to Publish when the Create Offer step fails', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_500');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('throws publish_<status> when the Publish Offer step fails, after both prior steps succeeded', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 503, ok: false, body: { errors: [{ message: 'service unavailable' }] } });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('publish_503');
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('sends the exact Create Offer request (headers + full body) for step 2', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(baseInput());

    const [, offerOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(offerOptions?.headers).toEqual({
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
      'Content-Language': 'en-US',
    });
    const body = offerOptions?.body as Record<string, unknown>;
    expect(body.marketplaceId).toBe('EBAY_US');
    expect(body.format).toBe('FIXED_PRICE');
    expect(body.availableQuantity).toBe(1);
    expect(body.listingDescription).toBe(
      'By F. Scott Fitzgerald\nPublisher: Scribner\nISBN: 9780743273565\nCondition: Good',
    );
  });

  it('sends the exact Publish Offer request (headers, method, URL) for step 3', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-999' } });

    await createListing(baseInput());

    const [publishUrl, publishOptions] = vi.mocked(apiFetch).mock.calls[2];
    expect(publishUrl).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc/publish');
    expect(publishOptions?.method).toBe('POST');
    expect(publishOptions?.headers).toEqual({
      Authorization: `Bearer ${FAKE_SECRET_TOKEN}`,
      'Content-Language': 'en-US',
    });
  });

  it('throws offer_bad_response (not a TypeError crash) when the Create Offer step returns ok:true with a null body', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: null });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_bad_response');
  });

  it('throws publish_bad_response (not a TypeError crash) when the Publish step returns ok:true with a null body', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: null });

    let thrown: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('publish_bad_response');
  });

  it('scrubs the access token out of the thrown error message at each of the 3 failing steps (inventory item / offer / publish)', async () => {
    // Step 1 (inventory item) failure with the token echoed back in the error body.
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 400,
      ok: false,
      body: { errors: [{ message: `bad request, saw token ${FAKE_SECRET_TOKEN}` }] },
    });
    let thrown1: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown1 = err;
    }
    expect((thrown1 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);

    // Step 2 (offer) failure with the token echoed back.
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
      });
    let thrown2: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown2 = err;
    }
    expect((thrown2 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);

    // Step 3 (publish) failure with the token echoed back.
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
      });
    let thrown3: unknown;
    try {
      await createListing(baseInput());
    } catch (err) {
      thrown3 = err;
    }
    expect((thrown3 as ConnectorPlatformError).message).not.toContain(FAKE_SECRET_TOKEN);
  });
});

describe('updateListing', () => {
  it('maps a 404 on the offer lookup to {ok:false, reason:"not_found"} instead of throwing', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 404, ok: false, body: { errors: [{ message: 'Offer not found' }] } });

    const result = await updateListing('does-not-exist', TENANT_ID, CONNECTION_ID, { title: 'x' });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('sends the exact GET offer request (URL, method, Bearer header)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'New Title' });

    const [getUrl, getOptions] = vi.mocked(apiFetch).mock.calls[0];
    expect(getUrl).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc');
    expect(getOptions?.method).toBe('GET');
    expect(getOptions?.headers).toEqual({ Authorization: `Bearer ${FAKE_SECRET_TOKEN}` });
  });

  it('a details-only patch (no title) still triggers the Inventory Item PUT', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, {
      details: { isbn: null, author: 'A', publisher: null, condition: 'Good' },
    });

    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toContain('/inventory_item/item-1-abc123');
  });

  it('returns {ok:true} after resolving the sku via GET offer and replacing the Inventory Item for a title patch', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'old desc' } }) // GET offer
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} }); // PUT inventory_item

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'New Title' });

    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const [invUrl, invOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(invUrl).toContain('/inventory_item/item-1-abc123');
    const body = invOptions?.body as { product: { title: string } };
    expect(body.product.title).toBe('New Title');
  });

  it('returns {ok:true} and PUTs the Offer for a priceCents-only patch', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } }) // GET offer
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} }); // PUT offer

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 2599 });

    expect(result).toEqual({ ok: true });
    const [offerUrl, offerOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(offerUrl).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc');
    expect(offerOptions?.method).toBe('PUT');
    const body = offerOptions?.body as { pricingSummary: { price: { value: string } } };
    expect(body.pricingSummary.price.value).toBe('25.99');
  });

  it('throws offer_get_<status> (not not_found) when the GET offer lookup fails with a non-not-found-shaped error', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    let thrown: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_get_500');
  });

  it('sends the exact Inventory Item PUT body for a title-only patch (condition omitted since patch.details is undefined)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'old desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'New Title' });

    const [, invOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(invOptions?.headers).toEqual({ Authorization: `Bearer ${FAKE_SECRET_TOKEN}`, 'Content-Language': 'en-US' });
    expect(invOptions?.body).toEqual({
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: undefined,
      product: { title: 'New Title' },
    });
  });

  it('sends condition mapped from patch.details when a details patch is included alongside title', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'old desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, {
      title: 'New Title',
      details: { isbn: null, author: 'A', publisher: null, condition: 'Good' },
    });

    const [, invOptions] = vi.mocked(apiFetch).mock.calls[1];
    const body = invOptions?.body as { condition: string };
    expect(body.condition).toBe('USED_GOOD');
  });

  it('maps a 404 on the Inventory Item PUT step to {ok:false, reason:"not_found"} instead of throwing', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 404, ok: false, body: { errors: [{ message: 'Invalid SKU' }] } });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('throws inventory_item_update_<status> when the Inventory Item PUT fails with a non-not-found error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    let thrown: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('inventory_item_update_500');
  });

  it('sends the exact Offer PUT body for a priceCents-only patch (sku + listingDescription carried over from the GET offer)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'carried desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 2599 });

    const [, offerOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(offerOptions?.headers).toEqual({ Authorization: `Bearer ${FAKE_SECRET_TOKEN}`, 'Content-Language': 'en-US' });
    expect(offerOptions?.body).toEqual({
      sku: 'item-1-abc123',
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      listingDescription: 'carried desc',
      pricingSummary: { price: { value: '25.99', currency: 'USD' } },
    });
  });

  it('maps a 404 on the Offer PUT step to {ok:false, reason:"not_found"} instead of throwing', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 404, ok: false, body: { errors: [{ message: 'Invalid offer' }] } });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 999 });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('throws offer_update_<status> when the Offer PUT fails with a non-not-found error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    let thrown: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 999 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_update_500');
  });

  it('patches both title and priceCents in one call: GET offer, then PUT inventory_item, then PUT offer (3 calls total)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'New Title', priceCents: 500 });

    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(apiFetch).mock.calls[1][1]?.method).toBe('PUT');
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toContain('/inventory_item/item-1-abc123');
    expect(vi.mocked(apiFetch).mock.calls[2][0]).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/offer-abc');
  });

  it('skips the Inventory Item PUT entirely when the GET offer response has no sku, even though title is patched', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ status: 200, ok: true, body: { listingDescription: 'desc' } });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'New Title' });

    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('a pure HTTP 404 (with a body message unrelated to any not-found phrase) is still classified as not_found -- isolates the status check from the text-based fallback', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ status: 404, ok: false, body: { errors: [{ message: 'unrelated generic error text' }] } });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('resolves sku/listingDescription to undefined (not a crash) when the GET offer response body is null', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: null })
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} });

    const result = await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 500 });

    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledTimes(2); // GET offer + PUT offer; sku/listingDescription resolve to undefined, no crash
    const [, offerOptions] = vi.mocked(apiFetch).mock.calls[1];
    const body = offerOptions?.body as { sku?: string; listingDescription?: unknown };
    expect(body.sku).toBeUndefined();
    expect(body.listingDescription).toBeUndefined();
  });

  it('scrubs the access token out of the thrown error message at each of the 3 failing steps (GET offer / inventory PUT / offer PUT)', async () => {
    // GET offer failure with the token echoed back.
    vi.mocked(apiFetch).mockResolvedValue({
      status: 500,
      ok: false,
      body: { errors: [{ message: `internal error, saw token ${FAKE_SECRET_TOKEN}` }] },
    });
    let thrown1: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown1 = err;
    }
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
    let thrown2: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' });
    } catch (err) {
      thrown2 = err;
    }
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
    let thrown3: unknown;
    try {
      await updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 999 });
    } catch (err) {
      thrown3 = err;
    }
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

    let thrown: unknown;
    try {
      await markSold('offer-abc', TENANT_ID, CONNECTION_ID);
    } catch (err) {
      thrown = err;
    }

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

    let thrown: unknown;
    try {
      await delist('offer-abc', TENANT_ID, CONNECTION_ID);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('delist_500');
  });

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

  it('falls back to String(body) in the thrown error message when the body cannot be JSON-stringified (circular reference)', async () => {
    const circular: Record<string, unknown> = { message: 'account suspended structure' };
    circular.self = circular;

    vi.mocked(apiFetch).mockResolvedValue({ status: 500, ok: false, body: circular });

    let thrown: unknown;
    try {
      await markSold('offer-abc', TENANT_ID, CONNECTION_ID);
    } catch (err) {
      thrown = err;
    }

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

    let thrown: unknown;
    try {
      await markSold('offer-abc', TENANT_ID, CONNECTION_ID);
    } catch (err) {
      thrown = err;
    }

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
    process.env.EBAY_ENV = 'production';

    await expect(createListing(baseInput())).rejects.toThrow(/production/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
