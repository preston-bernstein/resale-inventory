import { describe, it, expect, vi } from 'vitest';
import {
  CONNECTION_ID,
  FAKE_SECRET_TOKEN,
  TENANT_ID,
  baseInput,
  buildElectronicsInput,
  captureThrown,
} from './ebay.fixtures';
import type { ElectronicsDetails } from '@/lib/types';
import { apiFetch } from '../apiFetch';
import { createListing, updateListing } from '../ebay';
import { ConnectorPlatformError } from '../types';

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
});

describe('createListing', () => {
  it('throws if the create-offer step never returns an offerId', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: {} });

    const thrown = await captureThrown(() => createListing(baseInput()));

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

    const thrown = await captureThrown(() => createListing(baseInput()));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).platform).toBe('ebay');
    expect((thrown as ConnectorPlatformError).code).toBe('publish_bad_response');
    expect((thrown as ConnectorPlatformError).message).toContain('did not include a listingId');
  });
});

describe('createListing', () => {
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
});

describe('createListing', () => {
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
});

describe('createListing', () => {
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
});

describe('createListing', () => {
  it('creates an electronics listing with brand/model/processor/condition in description and maps to USED_GOOD condition', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-elec' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-elec' } });

    const input = buildElectronicsInput();
    const result = await createListing(input);

    expect(result).toEqual({ externalListingId: 'offer-elec' });

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { condition: string; product: { description: string } };
    expect(body.condition).toBe('USED_GOOD');
    const description = body.product.description;
    expect(description).toContain('Apple');
    expect(description).toContain('MacBook Pro');
    expect(description).toContain('M2');
    expect(description).toContain('Excellent');
    // Verify no book/clothing fields
    expect(description).not.toContain('ISBN:');
    expect(description).not.toContain('Size:');
  });

  it('maps an electronics condition of New to NEW (same "unused" bucket as clothing\'s NWT)', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-elec-new' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-elec-new' } });

    const input = buildElectronicsInput();
    input.details = { ...(input.details as ElectronicsDetails), condition: 'New' };
    await createListing(input);

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { condition: string };
    expect(body.condition).toBe('NEW');
  });
});

describe('createListing', () => {
  it('omits missing optional electronics fields (processor/ram/storage/screen/battery) from the description rather than leaving "null" lines', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-elec-min' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { listingId: 'listing-elec-min' } });

    const input = buildElectronicsInput();
    input.details = {
      ...input.details,
      processor: null,
      ram_gb: null,
      storage_gb: null,
      screen_size_in: null,
      battery_health_pct: null,
      battery_cycle_count: null,
    };
    await createListing(input);

    const [, inventoryOptions] = vi.mocked(apiFetch).mock.calls[0];
    const body = inventoryOptions?.body as { product: { description: string } };
    expect(body.product.description).toBe('Brand: Apple\nModel: MacBook Pro\nCondition: Excellent');
    expect(body.product.description).not.toContain('null');
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
});

describe('createListing', () => {
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

    const thrown = await captureThrown(() => createListing(baseInput()));

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

    const thrown = await captureThrown(() => createListing(baseInput()));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_500');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('createListing', () => {
  it('throws publish_<status> when the Publish Offer step fails, after both prior steps succeeded', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 503, ok: false, body: { errors: [{ message: 'service unavailable' }] } });

    const thrown = await captureThrown(() => createListing(baseInput()));

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
});

describe('createListing', () => {
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

    const thrown = await captureThrown(() => createListing(baseInput()));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_bad_response');
  });
});

describe('createListing', () => {
  it('throws publish_bad_response (not a TypeError crash) when the Publish step returns ok:true with a null body', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: {} })
      .mockResolvedValueOnce({ status: 201, ok: true, body: { offerId: 'offer-abc' } })
      .mockResolvedValueOnce({ status: 200, ok: true, body: null });

    const thrown = await captureThrown(() => createListing(baseInput()));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('publish_bad_response');
  });
});

describe('createListing', () => {
  it('scrubs the access token out of the thrown error message at each of the 3 failing steps (inventory item / offer / publish)', async () => {
    // Step 1 (inventory item) failure with the token echoed back in the error body.
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 400,
      ok: false,
      body: { errors: [{ message: `bad request, saw token ${FAKE_SECRET_TOKEN}` }] },
    });
    const thrown1 = await captureThrown(() => createListing(baseInput()));
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
    const thrown2 = await captureThrown(() => createListing(baseInput()));
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
    const thrown3 = await captureThrown(() => createListing(baseInput()));
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
});

describe('updateListing', () => {
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

    const thrown = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' }));

    expect(thrown).toBeInstanceOf(ConnectorPlatformError);
    expect((thrown as ConnectorPlatformError).code).toBe('offer_get_500');
  });
});

describe('updateListing', () => {
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
});

describe('updateListing', () => {
  it('throws inventory_item_update_<status> when the Inventory Item PUT fails with a non-not-found error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    const thrown = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { title: 'x' }));

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
});

describe('updateListing', () => {
  it('throws offer_update_<status> when the Offer PUT fails with a non-not-found error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ status: 200, ok: true, body: { sku: 'item-1-abc123', listingDescription: 'desc' } })
      .mockResolvedValueOnce({ status: 500, ok: false, body: { errors: [{ message: 'internal error' }] } });

    const thrown = await captureThrown(() => updateListing('offer-abc', TENANT_ID, CONNECTION_ID, { priceCents: 999 }));

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
});

describe('updateListing', () => {
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
});
