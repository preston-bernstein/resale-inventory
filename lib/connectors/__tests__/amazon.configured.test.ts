import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_MARKETPLACE_ID,
  TEST_ACCESS_TOKEN,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REFRESH_TOKEN,
  beforeEachAmazonConfigured,
  buildListingInput,
  mockSuccessfulLwaExchange,
} from './amazon.fixtures';
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
import { ConnectorPlatformError } from '../types';
import type { ListingInput } from '../types';

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('updateListing', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('updateListing', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('updateListing', () => {
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
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('markSold', () => {
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
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('delist', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('delist', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('checkConnectionHealth', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('checkConnectionHealth', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('LWA refresh-token revocation classification (req 18)', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('LWA refresh-token revocation classification (req 18)', () => {
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
  });
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

  describe('LWA refresh-token revocation classification (req 18)', () => {
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
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

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
});

describe('Amazon connector -- configured (mocked HTTP)', () => {
  beforeEach(beforeEachAmazonConfigured);

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
