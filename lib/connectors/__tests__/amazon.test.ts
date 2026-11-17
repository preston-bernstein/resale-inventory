import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CLIENT_ID_VAR,
  CLIENT_SECRET_VAR,
  DEFAULT_MARKETPLACE_ID,
  REFRESH_TOKEN_VAR,
  TEST_ACCESS_TOKEN,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REFRESH_TOKEN,
  beforeEachAmazonConfigured,
  beforeEachAmazonInertNot,
  buildElectronicsListingInput,
  buildListingInput,
  expectedBookCreateBody,
  mockSuccessfulLwaExchange,
} from './amazon.fixtures';
import { apiFetch } from '../apiFetch';
import { recordSuspensionSignal } from '@/lib/connections';
import { createListing, updateListing, markSold, delist, checkConnectionHealth } from '../amazon';
import { AmazonNotConfiguredError, ConnectorPlatformError } from '../types';
import type { ListingInput } from '../types';

describe('Amazon connector -- inert by default (not configured)', () => {
  beforeEach(beforeEachAmazonInertNot);

  it('createListing throws AmazonNotConfiguredError and never calls apiFetch', async () => {
    await expect(createListing(buildListingInput())).rejects.toThrow(AmazonNotConfiguredError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('updateListing throws AmazonNotConfiguredError and never calls apiFetch', async () => {
    await expect(
      updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', { title: 'New title' }),
    ).rejects.toThrow(AmazonNotConfiguredError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('markSold throws AmazonNotConfiguredError and never calls apiFetch', async () => {
    await expect(markSold('ext-listing-1', 'tenant-abc', 'connection-xyz')).rejects.toThrow(
      AmazonNotConfiguredError,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('delist throws AmazonNotConfiguredError and never calls apiFetch', async () => {
    await expect(delist('ext-listing-1', 'tenant-abc', 'connection-xyz')).rejects.toThrow(
      AmazonNotConfiguredError,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('checkConnectionHealth throws AmazonNotConfiguredError and never calls apiFetch', async () => {
    await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).rejects.toThrow(
      AmazonNotConfiguredError,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('Amazon connector -- inert by default (not configured)', () => {
  beforeEach(beforeEachAmazonInertNot);

  it('reports the correct platform and missing var on the thrown error', async () => {
    delete process.env[CLIENT_ID_VAR];
    process.env[CLIENT_SECRET_VAR] = TEST_CLIENT_SECRET;
    process.env[REFRESH_TOKEN_VAR] = TEST_REFRESH_TOKEN;

    try {
      await createListing(buildListingInput());
      expect.unreachable('createListing should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AmazonNotConfiguredError);
      const typed = err as AmazonNotConfiguredError;
      expect(typed.platform).toBe('amazon');
      expect(typed.missingVar).toBe(CLIENT_ID_VAR);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws even when only REFRESH_TOKEN_VAR is missing (the other two present)', async () => {
    process.env[CLIENT_ID_VAR] = TEST_CLIENT_ID;
    process.env[CLIENT_SECRET_VAR] = TEST_CLIENT_SECRET;
    delete process.env[REFRESH_TOKEN_VAR];

    let thrown: unknown;
    try {
      await checkConnectionHealth('tenant-abc', 'connection-xyz');
      expect.unreachable('checkConnectionHealth should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AmazonNotConfiguredError);
    expect((thrown as AmazonNotConfiguredError).missingVar).toBe(REFRESH_TOKEN_VAR);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws even when only CLIENT_ID_VAR is missing (the other two present) -- checked first, before CLIENT_SECRET_VAR', async () => {
    delete process.env[CLIENT_ID_VAR];
    process.env[CLIENT_SECRET_VAR] = TEST_CLIENT_SECRET;
    process.env[REFRESH_TOKEN_VAR] = TEST_REFRESH_TOKEN;

    const err = await checkConnectionHealth('tenant-abc', 'connection-xyz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmazonNotConfiguredError);
    expect((err as AmazonNotConfiguredError).missingVar).toBe(CLIENT_ID_VAR);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('Amazon connector -- inert by default (not configured)', () => {
  beforeEach(beforeEachAmazonInertNot);

  it('throws even when only CLIENT_SECRET_VAR is missing (the other two present) -- checked between CLIENT_ID_VAR and REFRESH_TOKEN_VAR', async () => {
    process.env[CLIENT_ID_VAR] = TEST_CLIENT_ID;
    delete process.env[CLIENT_SECRET_VAR];
    process.env[REFRESH_TOKEN_VAR] = TEST_REFRESH_TOKEN;

    const err = await checkConnectionHealth('tenant-abc', 'connection-xyz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmazonNotConfiguredError);
    expect((err as AmazonNotConfiguredError).missingVar).toBe(CLIENT_SECRET_VAR);
    expect((err as AmazonNotConfiguredError).platform).toBe('amazon');
    expect((err as Error).message).toContain(CLIENT_SECRET_VAR);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('exchanges an LWA token then PUTs the SP-API Listings Items endpoint, returning the SKU as externalListingId', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-123', submissionId: 'abc-123' },
      });

      const input = buildListingInput();
      const result = await createListing(input);

      expect(result).toEqual({ externalListingId: 'item-123' });
      expect(apiFetch).toHaveBeenCalledTimes(2);

      const [lwaUrl, lwaOptions] = vi.mocked(apiFetch).mock.calls[0];
      expect(lwaUrl).toBe('https://api.amazon.com/auth/o2/token');
      expect(lwaOptions?.method).toBe('POST');
      expect(lwaOptions?.body).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: TEST_REFRESH_TOKEN,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      });

      const [spUrl, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      // Exact URL -- pins the path segments, encoding, and marketplace query
      // param value, not just "contains something roughly right."
      expect(spUrl).toBe(
        `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${encodeURIComponent(
          input.connectionId,
        )}/${encodeURIComponent(input.itemId)}?marketplaceIds=${DEFAULT_MARKETPLACE_ID}`,
      );
      expect(spOptions?.method).toBe('PUT');
      expect(spOptions?.headers).toEqual({ 'x-amz-access-token': TEST_ACCESS_TOKEN });

      expect(spOptions?.body).toEqual(expectedBookCreateBody(input));
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('maps category "clothing" to productType CLOTHING and builds the clothing description', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-clothing', submissionId: 'abc-124' },
      });

      const input = buildListingInput({
        category: 'clothing',
        details: {
          brand: 'Levi',
          size_label: 'M',
          color: '',
          condition: 'Excellent',
        } as unknown as ListingInput['details'],
      });

      await createListing(input);

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      const body = spOptions?.body as Record<string, unknown>;
      expect(body.productType).toBe('CLOTHING');
      const attrs = body.attributes as Record<string, unknown>;
      const productDescription = attrs.product_description as { value: string }[];
      // color is falsy ('') so it must be omitted, not rendered as "Color: ".
      expect(productDescription[0].value).toBe('Brand: Levi\nSize: M\nCondition: Excellent');
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('maps category "electronics" to productType ELECTRONICS and includes electronics fields in the description', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-elec-456', submissionId: 'abc-125' },
      });

      const input = buildElectronicsListingInput();
      await createListing(input);

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      const body = spOptions?.body as Record<string, unknown>;
      expect(body.productType).toBe('ELECTRONICS');
      const attrs = body.attributes as Record<string, unknown>;
      const productDescription = attrs.product_description as { value: string }[];
      // Description should include electronics fields and not book/clothing fields
      const description = productDescription[0].value;
      expect(description).toContain('Apple');
      expect(description).toContain('MacBook Pro');
      expect(description).toContain('M2');
      expect(description).toContain('Excellent');
      expect(description).not.toContain('ISBN:');
      expect(description).not.toContain('Size:');
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('omits a missing optional book field from the description with no blank line left behind', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-123' },
      });

      const input = buildListingInput({
        details: {
          author: 'F. Scott Fitzgerald',
          publisher: 'Scribner',
          condition: 'Good',
        } as unknown as ListingInput['details'],
      });

      await createListing(input);

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      const attrs = (spOptions?.body as Record<string, unknown>).attributes as Record<string, unknown>;
      const productDescription = attrs.product_description as { value: string }[];
      expect(productDescription[0].value).toBe('By F. Scott Fitzgerald\nPublisher: Scribner\nCondition: Good');
    });

    it('divides priceCents by 100 (not multiplies) to build value_with_tax', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-123' },
      });

      await createListing(buildListingInput({ priceCents: 4250 }));

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      const attrs = (spOptions?.body as Record<string, unknown>).attributes as Record<string, unknown>;
      const offer = attrs.purchasable_offer as { our_price: { schedule: { value_with_tax: number }[] }[] }[];
      expect(offer[0].our_price[0].schedule[0].value_with_tax).toBe(42.5);
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('maps a non-2xx SP-API response to a scrubbed ConnectorPlatformError with the exact sp_api_create_<status> code and platform', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { errors: [{ code: 'InvalidInput', message: 'attributes.item_name is required' }] },
      });

      const err = await createListing(buildListingInput()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).code).toBe('sp_api_create_400');
      expect((err as ConnectorPlatformError).platform).toBe('amazon');
      expect((err as ConnectorPlatformError).message).toContain('attributes.item_name is required');
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('wraps an LWA network error as lwa_network_error and scrubs the client secret out of the message (no downstream re-scrub layer on this path)', async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(
        new Error(`connect ECONNRESET, config was clientSecret=${TEST_CLIENT_SECRET}`),
      );

      const err = await createListing(buildListingInput()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).code).toBe('lwa_network_error');
      expect((err as ConnectorPlatformError).platform).toBe('amazon');
      expect((err as ConnectorPlatformError).message).not.toContain(TEST_CLIENT_SECRET);
    });

    it('propagates a non-2xx LWA token response as lwa_<status>, uncaught by createListing', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { error: 'invalid_client', error_description: 'client authentication failed' },
      });

      const err = await createListing(buildListingInput()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).code).toBe('lwa_400');
      expect((err as ConnectorPlatformError).platform).toBe('amazon');
      expect((err as ConnectorPlatformError).message).toContain('client authentication failed');
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('throws lwa_bad_response when the LWA token response is missing access_token', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { token_type: 'bearer', expires_in: 3600 },
      });

      await expect(createListing(buildListingInput())).rejects.toMatchObject({
        code: 'lwa_bad_response',
        platform: 'amazon',
      });
    });

    it('scrubs the access token out of the thrown message for a 403 createListing failure whose body embeds it', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: {
          errors: [
            {
              code: 'Unauthorized',
              message: `Access token ${TEST_ACCESS_TOKEN} rejected -- seller account suspended`,
            },
          ],
        },
      });

      const err = await createListing(buildListingInput()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).message).not.toContain(TEST_ACCESS_TOKEN);
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('classifies a 403 suspension-shaped response and calls recordSuspensionSignal exactly once with a scrubbed, non-secret reason', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: {
          errors: [
            {
              code: 'Unauthorized',
              message: 'The seller account has been suspended and API access has been revoked.',
            },
          ],
        },
      });

      const input = buildListingInput();
      await expect(createListing(input)).rejects.toThrow(ConnectorPlatformError);

      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [tenantId, connectionId, reason, toStatus] = vi.mocked(recordSuspensionSignal).mock.calls[0];
      expect(tenantId).toBe(input.tenantId);
      expect(connectionId).toBe(input.connectionId);
      expect(toStatus).toBe('suspended');
      expect(reason).not.toContain(TEST_ACCESS_TOKEN);
      expect(reason).not.toContain(TEST_CLIENT_SECRET);
      expect(reason).not.toContain(TEST_REFRESH_TOKEN);
      expect(reason.length).toBeLessThan(200);
    });

    it('does not call recordSuspensionSignal for a transient 500 server error', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ code: 'InternalFailure', message: 'Internal Server Error' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('does not call recordSuspensionSignal for a 429 rate-limit response', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 429,
        ok: false,
        body: { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not call recordSuspensionSignal for an ambiguous 403 that does not mention suspension/revocation', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'AccessDenied', message: 'Missing required IAM permission for this operation' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    // SP_API_SUSPENSION_PATTERN has 3 independent alternations
    // (account.*(suspend|...), seller.*(suspend|...), api access.*(revok|...)).
    // Each of the next 3 tests triggers exactly ONE alternation, with a gap
    // of more than one character between the anchor word and the keyword
    // (so a ".*" -> "." mutant on that branch specifically fails to match),
    // and avoids the other two anchor words entirely so a broken branch
    // can't be masked by one of its siblings still matching.
    it('classifies suspension via the "account...suspend" branch in isolation', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Forbidden', message: 'This account was permanently terminated.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('classifies suspension via the "seller...deactivat" branch in isolation', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Forbidden', message: 'This seller has been deactivated.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });

    it('classifies suspension via the "api access...revok" branch in isolation', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Forbidden', message: 'Your api access has recently been revoked.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });

    it('does not classify a bare "account" mention with no suspend/deactivate/terminate/revoke keyword', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Forbidden', message: 'This account cannot list in this category.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('does not call recordSuspensionSignal for a 403 with a non-object body (extractSpApiErrors returns [])', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: 'account suspended -- plain string body, not the {errors:[...]} shape',
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not call recordSuspensionSignal for a 403 whose "errors" field is not an array', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: 'account suspended' },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not call recordSuspensionSignal when error entries have non-string code/message fields', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        // Non-object array entries and numeric code/message must be dropped
        // (mapped to undefined), not stringified into the classification
        // text -- otherwise "403" or similar could accidentally match.
        body: { errors: [403, { code: 403, message: 403 }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('classifies suspension from a string "code" field alone (message absent)', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'AccountSuspended' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });

    it('does not crash on a null 403 body -- extractSpApiErrors returns [] instead of throwing', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: null,
      });

      // A raw TypeError from indexing into null would fail this
      // instanceof check; only the guarded, safe path produces a
      // ConnectorPlatformError here.
      await expect(createListing(buildListingInput())).rejects.toBeInstanceOf(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('records the reason as amazon_403_<code> when the matched error has a code', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'AccountSuspended', message: 'account suspended' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      const [, , reason] = vi.mocked(recordSuspensionSignal).mock.calls[0];
      expect(reason).toBe('amazon_403_AccountSuspended');
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('createListing', () => {
    it('records the reason as amazon_403_access_denied (fallback) when the matched error has no code', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ message: 'This seller account has been suspended.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      const [, , reason] = vi.mocked(recordSuspensionSignal).mock.calls[0];
      expect(reason).toBe('amazon_403_access_denied');
    });

    it('does NOT call recordSuspensionSignal for a non-403 status whose body text happens to be suspension-shaped', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ code: 'InternalFailure', message: 'This account was permanently terminated.' }] },
      });

      await expect(createListing(buildListingInput())).rejects.toThrow(ConnectorPlatformError);
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('updateListing', () => {
    it('sends a PATCH built from the patch fields and returns {ok:true} on success', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'ext-listing-1', status: 'ACCEPTED' },
      });

      const result = await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', {
        title: 'Updated title',
        priceCents: 1599,
      });

      expect(result).toEqual({ ok: true });

      const [spUrl, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      expect(spUrl).toBe(
        `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/connection-xyz/ext-listing-1?marketplaceIds=${DEFAULT_MARKETPLACE_ID}`,
      );
      expect(spOptions?.method).toBe('PATCH');
      // Full body equality -- pins both patch ops exactly (path, op, and
      // value shape), not just "contains a patch with this path somewhere."
      expect(spOptions?.body).toEqual({
        patches: [
          {
            op: 'replace',
            path: '/attributes/item_name',
            value: [{ value: 'Updated title', marketplace_id: DEFAULT_MARKETPLACE_ID }],
          },
          {
            op: 'replace',
            path: '/attributes/purchasable_offer',
            value: [
              {
                marketplace_id: DEFAULT_MARKETPLACE_ID,
                currency: 'USD',
                our_price: [{ schedule: [{ value_with_tax: 15.99 }] }],
              },
            ],
          },
        ],
      });
    });
  });
});
