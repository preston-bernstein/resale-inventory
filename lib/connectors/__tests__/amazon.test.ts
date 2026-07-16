import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// amazon.ts's transport dependency is apiFetch and its suspension-signal
// dependency is lib/connections.ts's recordSuspensionSignal -- both mocked
// at the module boundary so this file tests only amazon.ts's own
// gating/request-shaping/error-mapping/suspension-classification logic, not
// apiFetch.ts's retry/timeout behavior (apiFetch.test.ts) or
// lib/connections.ts's DB-backed transition logic (tests/api/kill-switch.test.ts).
vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

import { apiFetch } from '../apiFetch';
import { recordSuspensionSignal } from '@/lib/connections';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  amazonConnector,
} from '../amazon';
import { AmazonNotConfiguredError, ConnectorPlatformError } from '../types';
import type { ListingInput } from '../types';

const DEFAULT_MARKETPLACE_ID = 'ATVPDKIKX0DER';

const CLIENT_ID_VAR = 'AMAZON_LWA_CLIENT_ID';
const CLIENT_SECRET_VAR = 'AMAZON_LWA_CLIENT_SECRET';
const REFRESH_TOKEN_VAR = 'AMAZON_SP_API_REFRESH_TOKEN';
const AMAZON_ENV_VARS = [CLIENT_ID_VAR, CLIENT_SECRET_VAR, REFRESH_TOKEN_VAR] as const;

const TEST_CLIENT_ID = 'amzn1.application-oa2-client.test-client-id';
const TEST_CLIENT_SECRET = 'test-client-secret-value';
const TEST_REFRESH_TOKEN = 'Atzr|test-refresh-token-value';
const TEST_ACCESS_TOKEN = 'Atza|test-access-token-value';

function buildListingInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    itemId: 'item-123',
    tenantId: 'tenant-abc',
    connectionId: 'connection-xyz',
    title: 'The Great Gatsby',
    priceCents: 1299,
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

function mockSuccessfulLwaExchange() {
  vi.mocked(apiFetch).mockResolvedValueOnce({
    status: 200,
    ok: true,
    body: {
      access_token: TEST_ACCESS_TOKEN,
      refresh_token: TEST_REFRESH_TOKEN,
      token_type: 'bearer',
      expires_in: 3600,
    },
  });
}

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of AMAZON_ENV_VARS) {
    originalEnv[v] = process.env[v];
  }
  vi.mocked(apiFetch).mockReset();
  vi.mocked(recordSuspensionSignal).mockReset();
});

afterEach(() => {
  for (const v of AMAZON_ENV_VARS) {
    if (originalEnv[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = originalEnv[v];
    }
  }
});

// ---------------------------------------------------------------------------
// Inert by default: all 5 methods must throw AmazonNotConfiguredError before
// ever attempting an HTTP call, when any/all of the 3 required env vars are
// unset.
// ---------------------------------------------------------------------------

describe('Amazon connector -- inert by default (not configured)', () => {
  beforeEach(() => {
    for (const v of AMAZON_ENV_VARS) {
      delete process.env[v];
    }
  });

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

// ---------------------------------------------------------------------------
// Wired, not just guarded: with all 3 env vars set, exercise the real
// request-building / error-mapping / suspension-classification logic against
// mocked HTTP responses. No live SP-API calls anywhere in this file.
// ---------------------------------------------------------------------------

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(() => {
    process.env[CLIENT_ID_VAR] = TEST_CLIENT_ID;
    process.env[CLIENT_SECRET_VAR] = TEST_CLIENT_SECRET;
    process.env[REFRESH_TOKEN_VAR] = TEST_REFRESH_TOKEN;
  });

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

      // Full body equality -- a mutant that guts productType, drops a
      // required attribute, or corrupts the price/description shape would
      // slip past a toMatchObject() partial check but not this.
      expect(spOptions?.body).toEqual({
        productType: 'BOOKS',
        requirements: 'LISTING',
        attributes: {
          item_name: [{ value: input.title, marketplace_id: DEFAULT_MARKETPLACE_ID }],
          product_description: [
            {
              value: 'By F. Scott Fitzgerald\nPublisher: Scribner\nISBN: 9780743273565\nCondition: Good',
              marketplace_id: DEFAULT_MARKETPLACE_ID,
            },
          ],
          condition_type: [{ value: 'used_good', marketplace_id: DEFAULT_MARKETPLACE_ID }],
          purchasable_offer: [
            {
              marketplace_id: DEFAULT_MARKETPLACE_ID,
              currency: 'USD',
              our_price: [{ schedule: [{ value_with_tax: input.priceCents / 100 }] }],
            },
          ],
        },
      });
    });

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

    it('omits title/price ops entirely when the patch is empty', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'ext-listing-1' },
      });

      await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', {});

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      expect(spOptions?.body).toEqual({ patches: [] });
    });

    it('includes a product_description patch op (JSON-stringified) when patch.details is provided', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'ext-listing-1' },
      });

      const details = { condition: 'Like New' } as unknown as ListingInput['details'];
      await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', { details });

      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      expect(spOptions?.body).toEqual({
        patches: [
          {
            op: 'replace',
            path: '/attributes/product_description',
            value: [{ value: JSON.stringify(details), marketplace_id: DEFAULT_MARKETPLACE_ID }],
          },
        ],
      });
    });

    it('maps a 404 SP-API response to {ok:false, reason:"not_found"} (status-only, unrelated error code)', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 404,
        ok: false,
        // Deliberately NOT code:'NotFound', so this only passes via the
        // status === 404 check, not the errors[].code fallback -- kills a
        // mutant that guts the status check but leaves the code fallback.
        body: { errors: [{ code: 'Gone', message: 'no longer available' }] },
      });

      const result = await updateListing('nonexistent-listing', 'tenant-abc', 'connection-xyz', {
        title: 'New title',
      });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('maps a non-404 status carrying a NotFound error code to {ok:false, reason:"not_found"} (code-fallback path)', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { errors: [{ code: 'InvalidInput', message: 'bad request' }, { code: 'NotFound' }] },
      });

      const result = await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', { title: 'x' });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('does NOT map a non-404 status with no NotFound error code to not_found -- throws instead', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { errors: [{ code: 'InvalidInput', message: 'bad request' }] },
      });

      await expect(
        updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', { title: 'x' }),
      ).rejects.toBeInstanceOf(ConnectorPlatformError);
    });

    it('throws sp_api_update_<status> as the error code on a non-404, non-suspension failure, with the platform and body content in the message', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ code: 'InternalFailure', message: 'boom' }] },
      });

      const err = await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', {
        title: 'x',
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'sp_api_update_500', platform: 'amazon' });
      expect((err as ConnectorPlatformError).message).toContain('boom');
    });

    it('scrubs the access token out of the thrown message for a 403 updateListing failure whose body embeds it', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Unauthorized', message: `token ${TEST_ACCESS_TOKEN} -- account terminated` }] },
      });

      const err = await updateListing('ext-listing-1', 'tenant-abc', 'connection-xyz', { title: 'x' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).message).not.toContain(TEST_ACCESS_TOKEN);
    });
  });

  describe('markSold', () => {
    it('sends a PATCH zeroing fulfillment_availability and returns {ok:true} on success', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'ext-listing-1', status: 'ACCEPTED' },
      });

      const result = await markSold('ext-listing-1', 'tenant-abc', 'connection-xyz');

      expect(result).toEqual({ ok: true });
      const [, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      expect(spOptions?.method).toBe('PATCH');
      // Full body equality -- the op literal, path, and zeroed quantity all
      // matter (a wrong quantity would silently fail to mark the item sold).
      expect(spOptions?.body).toEqual({
        patches: [
          {
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [{ marketplace_id: DEFAULT_MARKETPLACE_ID, quantity: 0 }],
          },
        ],
      });
    });

    it('maps a 404 SP-API response to {ok:false, reason:"not_found"} (status-only, unrelated error code)', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 404,
        ok: false,
        body: { errors: [{ code: 'Gone', message: 'gone' }] },
      });

      const result = await markSold('nonexistent-listing', 'tenant-abc', 'connection-xyz');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('throws sp_api_mark_sold_<status> as the error code on a non-404, non-suspension failure', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ code: 'InternalFailure', message: 'boom' }] },
      });

      await expect(markSold('ext-listing-1', 'tenant-abc', 'connection-xyz')).rejects.toMatchObject({
        code: 'sp_api_mark_sold_500',
      });
    });

    it('scrubs the access token out of the thrown message for a 403 markSold failure whose body embeds it', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Unauthorized', message: `token ${TEST_ACCESS_TOKEN} -- account terminated` }] },
      });

      const err = await markSold('ext-listing-1', 'tenant-abc', 'connection-xyz').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).message).not.toContain(TEST_ACCESS_TOKEN);
    });
  });

  describe('delist', () => {
    it('sends a DELETE with no body to the exact listing URL and returns {ok:true} on success', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'ext-listing-1', status: 'ACCEPTED' },
      });

      const result = await delist('ext-listing-1', 'tenant-abc', 'connection-xyz');

      expect(result).toEqual({ ok: true });
      const [spUrl, spOptions] = vi.mocked(apiFetch).mock.calls[1];
      expect(spUrl).toBe(
        `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/connection-xyz/ext-listing-1?marketplaceIds=${DEFAULT_MARKETPLACE_ID}`,
      );
      expect(spOptions?.method).toBe('DELETE');
      expect(spOptions?.body).toBeUndefined();
    });

    it('maps a 404 SP-API response to {ok:false, reason:"not_found"} (status-only, unrelated error code)', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 404,
        ok: false,
        body: { errors: [{ code: 'Gone', message: 'gone' }] },
      });

      const result = await delist('nonexistent-listing', 'tenant-abc', 'connection-xyz');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('throws sp_api_delist_<status> as the error code on a non-404, non-suspension failure', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { errors: [{ code: 'InternalFailure', message: 'boom' }] },
      });

      await expect(delist('ext-listing-1', 'tenant-abc', 'connection-xyz')).rejects.toMatchObject({
        code: 'sp_api_delist_500',
      });
    });

    it('classifies a 403 suspension-shaped response on delist and calls recordSuspensionSignal exactly once', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Unauthorized', message: 'Seller account is deactivated.' }] },
      });

      await expect(delist('ext-listing-1', 'tenant-abc', 'connection-xyz')).rejects.toThrow(
        ConnectorPlatformError,
      );
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
      expect(recordSuspensionSignal).toHaveBeenCalledWith(
        'tenant-abc',
        'connection-xyz',
        expect.any(String),
        'suspended',
      );
    });

    it('scrubs the access token out of the thrown message for a 403 delist failure whose body embeds it', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { errors: [{ code: 'Unauthorized', message: `token ${TEST_ACCESS_TOKEN} -- account terminated` }] },
      });

      const err = await delist('ext-listing-1', 'tenant-abc', 'connection-xyz').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorPlatformError);
      expect((err as ConnectorPlatformError).message).not.toContain(TEST_ACCESS_TOKEN);
    });
  });

  describe('checkConnectionHealth', () => {
    it('returns {healthy: true} when the LWA exchange succeeds, hitting the exact LWA URL/body', async () => {
      mockSuccessfulLwaExchange();

      const result = await checkConnectionHealth('tenant-abc', 'connection-xyz');

      expect(result).toEqual({ healthy: true });
      expect(apiFetch).toHaveBeenCalledTimes(1);
      const [url, options] = vi.mocked(apiFetch).mock.calls[0];
      expect(url).toBe('https://api.amazon.com/auth/o2/token');
      expect(options?.method).toBe('POST');
      expect(options?.body).toEqual({
        grant_type: 'refresh_token',
        refresh_token: TEST_REFRESH_TOKEN,
        client_id: TEST_CLIENT_ID,
        client_secret: TEST_CLIENT_SECRET,
      });
    });

    it('returns {healthy: false, detail} without leaking credentials when the LWA exchange fails, with a status-specific, content-bearing detail', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { error: 'invalid_grant', error_description: 'The refresh token is malformed' },
      });

      const result = await checkConnectionHealth('tenant-abc', 'connection-xyz');

      expect(result.healthy).toBe(false);
      expect(result.detail).toBeDefined();
      // safeStringify(body) must actually run and the lwa_<status> code
      // must actually be built -- kills mutants that empty either.
      expect(result.detail).toContain('lwa_400');
      expect(result.detail).toContain('refresh token is malformed');
      expect(result.detail).not.toContain(TEST_CLIENT_SECRET);
      expect(result.detail).not.toContain(TEST_REFRESH_TOKEN);
      expect(result.detail).not.toContain(TEST_CLIENT_ID);
    });

    it('does not throw for an ordinary platform failure -- only AmazonNotConfiguredError throws', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 500,
        ok: false,
        body: { error: 'server_error' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('scrubs a secret embedded in a network-error message out of the returned detail', async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(
        new Error(`connect ECONNREFUSED, last known secret was ${TEST_CLIENT_SECRET}`),
      );

      const result = await checkConnectionHealth('tenant-abc', 'connection-xyz');

      expect(result.healthy).toBe(false);
      expect(result.detail).not.toContain(TEST_CLIENT_SECRET);
    });
  });

  describe('LWA refresh-token revocation classification (req 18)', () => {
    it('classifies an invalid_grant response whose description mentions revocation as a suspension signal', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: {
          error: 'invalid_grant',
          error_description: 'The refresh token has been revoked by the seller.',
        },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });

      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [, , reason, toStatus] = vi.mocked(recordSuspensionSignal).mock.calls[0];
      expect(toStatus).toBe('suspended');
      expect(reason).not.toContain(TEST_REFRESH_TOKEN);
    });

    it('does not classify a generic/expired invalid_grant response (no revocation wording) as a suspension signal', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { error: 'invalid_grant', error_description: 'The refresh token is expired' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not classify a network/timeout failure of the LWA exchange as a suspension signal', async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(new Error('network error'));
      vi.mocked(apiFetch).mockRejectedValueOnce(new Error('network error'));

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('classifies error "unauthorized_client" as amazon_lwa_unauthorized_client regardless of description wording', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 401,
        ok: false,
        body: { error: 'unauthorized_client', error_description: 'anything at all, not a revocation keyword' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });

      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [, , reason] = vi.mocked(recordSuspensionSignal).mock.calls[0];
      expect(reason).toBe('amazon_lwa_unauthorized_client');
    });

    it('classifies revocation at LWA status boundary 401 (not just 400)', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 401,
        ok: false,
        body: { error: 'invalid_grant', error_description: 'refresh token was revoked by owner' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });

    it('classifies revocation at LWA status boundary 403 (not just 400)', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: { error: 'invalid_grant', error_description: 'refresh token was revoked by owner' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).toHaveBeenCalledTimes(1);
    });

    it('does NOT classify revocation-shaped wording at a status outside {400,401,403} (e.g. 402)', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 402,
        ok: false,
        body: { error: 'invalid_grant', error_description: 'refresh token was revoked by owner' },
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not classify a non-object LWA error body (extractErrorText-style guard)', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: 'invalid_grant: revoked by seller',
      });

      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });

    it('does not crash on a null LWA error body -- classifyLwaRevocationReason returns null instead of throwing', async () => {
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: null,
      });

      // A raw TypeError from indexing into null would surface as an
      // unhandled rejection here; checkConnectionHealth is documented to
      // never throw except for AmazonNotConfiguredError.
      await expect(checkConnectionHealth('tenant-abc', 'connection-xyz')).resolves.toMatchObject({
        healthy: false,
      });
      expect(recordSuspensionSignal).not.toHaveBeenCalled();
    });
  });

  describe('no credential leak', () => {
    it('never includes raw secret values in a thrown ConnectorPlatformError message', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 403,
        ok: false,
        body: {
          errors: [
            {
              code: 'Unauthorized',
              message: `Access token ${TEST_ACCESS_TOKEN} is not authorized -- seller account suspended`,
            },
          ],
        },
      });

      try {
        await createListing(buildListingInput());
        expect.unreachable('createListing should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorPlatformError);
        const message = (err as Error).message;
        expect(message).not.toContain(TEST_ACCESS_TOKEN);
        expect(message).not.toContain(TEST_CLIENT_SECRET);
        expect(message).not.toContain(TEST_REFRESH_TOKEN);
      }
    });
  });

  describe('DEFAULT_MARKETPLACE_ID', () => {
    it('is the real Amazon.com (US) marketplace id, used consistently across the listings URL and every attribute payload', async () => {
      mockSuccessfulLwaExchange();
      vi.mocked(apiFetch).mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { sku: 'item-123' },
      });

      const input = buildListingInput();
      await createListing(input);

      const [spUrl] = vi.mocked(apiFetch).mock.calls[1];
      expect(spUrl).toContain(`marketplaceIds=${DEFAULT_MARKETPLACE_ID}`);
      expect(DEFAULT_MARKETPLACE_ID).toBe('ATVPDKIKX0DER');
    });
  });
});

describe('amazonConnector export shape', () => {
  it('exposes all 5 Connector methods', () => {
    expect(amazonConnector).toMatchObject({
      createListing,
      updateListing,
      markSold,
      delist,
      checkConnectionHealth,
    });
    expect(Object.keys(amazonConnector).sort()).toEqual(
      ['checkConnectionHealth', 'createListing', 'delist', 'markSold', 'updateListing'].sort(),
    );
  });
});
