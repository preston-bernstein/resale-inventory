import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ListingInput } from '../types';

// etsy.test.ts mocks '../apiCredential' (getFreshAccessToken) directly and
// always seeds a token via that mock -- it never actually drives
// etsyExchangeFn (etsy.ts's internal, unexported OAuth refresh_token-grant
// function). This file exercises that real path end-to-end: an EXPIRED
// stored credential forces the REAL getFreshAccessToken (apiCredential.ts)
// to call the REAL etsyExchangeFn, which POSTs to Etsy's real token
// endpoint. Only the transport boundary (apiFetch) and the CRUD/encryption
// layer underneath getDecryptedCredential/rotateCredential
// (lib/connections.ts) are mocked -- same boundary apiCredential.test.ts and
// ebay.oauth.test.ts each use for their own connector's real-refresh-path
// coverage. (etsyExchangeFn itself stays unexported per the earlier
// dead-code cleanup -- it's driven indirectly via a real connector method,
// same as production code does.)
vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  rotateCredential: vi.fn(),
  recordSuspensionSignal: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { getDecryptedCredential, rotateCredential } from '@/lib/connections';
import { apiFetch } from '../apiFetch';
import { createListing } from '../etsy';
import { ConnectorPlatformError } from '../types';

const TENANT_ID = 'tenant-1';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_API_KEY = 'test-etsy-api-key';
const ETSY_SHARED_SECRET = 'test-etsy-shared-secret';

function baseInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    itemId: 'item-1',
    tenantId: TENANT_ID,
    connectionId: 'default-conn',
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

// The same stored object doubles as both getFreshAccessToken's and
// getEtsyShopId's read of getDecryptedCredential (both call it with the same
// tenantId/connectionId in each connector method) -- accessToken/expiresAt/
// refreshToken feed the former, shopId feeds the latter.
function expiredStoredCredential(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'stale-access-token',
    expiresAt: Date.now() - 1000, // already expired
    refreshToken: 'stored-refresh-token',
    shopId: 'shop-123',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getDecryptedCredential).mockReset();
  vi.mocked(rotateCredential).mockReset();
  vi.mocked(apiFetch).mockReset();

  process.env.ETSY_API_KEY = ETSY_API_KEY;
  process.env.ETSY_SHARED_SECRET = ETSY_SHARED_SECRET;

  vi.mocked(rotateCredential).mockReturnValue(null);
});

describe('etsyExchangeFn (driven indirectly via an expired stored credential)', () => {
  it('exchanges the stored refresh token against the real Etsy token endpoint, then uses the freshly exchanged access token for the listing call', async () => {
    // Unique connectionId per test: apiCredential.ts's in-memory tokenCache
    // is module-level and NOT mocked here, so a shared id would leak a
    // cached/rotated token across tests in this file.
    const connectionId = 'expired-conn-1';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredStoredCredential());

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === ETSY_TOKEN_URL) {
        return {
          status: 200,
          ok: true,
          body: {
            access_token: 'freshly-exchanged-access-token',
            expires_in: 3600,
            refresh_token: 'freshly-exchanged-refresh-token',
            token_type: 'Bearer',
          },
        };
      }
      return { status: 201, ok: true, body: { listing_id: 999 } };
    });

    const result = await createListing(baseInput({ connectionId }));

    expect(result).toEqual({ externalListingId: '999' });
    expect(apiFetch).toHaveBeenCalledTimes(2);

    // Call 1: the token exchange itself -- pins the exact endpoint, Basic
    // auth, and refresh_token grant params etsyExchangeFn builds.
    const [tokenUrl, tokenOptions] = vi.mocked(apiFetch).mock.calls[0];
    expect(tokenUrl).toBe(ETSY_TOKEN_URL);
    expect(tokenOptions?.method).toBe('POST');
    const expectedBasicAuth = Buffer.from(`${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`).toString('base64');
    expect(tokenOptions?.headers?.Authorization).toBe(`Basic ${expectedBasicAuth}`);
    expect(tokenOptions?.headers?.['x-api-key']).toBe(ETSY_API_KEY);
    expect(tokenOptions?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'stored-refresh-token',
      client_id: ETSY_API_KEY,
    });

    // Call 2: the actual listing-create call -- must carry the FRESHLY
    // exchanged access token, not the stale stored one.
    const [listingUrl, listingOptions] = vi.mocked(apiFetch).mock.calls[1];
    expect(listingUrl).toBe('https://api.etsy.com/v3/application/shops/shop-123/listings');
    expect(listingOptions?.headers?.Authorization).toBe('Bearer freshly-exchanged-access-token');

    // And the rotated credential is what got persisted for next time.
    expect(rotateCredential).toHaveBeenCalledTimes(1);
    expect(rotateCredential).toHaveBeenCalledWith(
      TENANT_ID,
      connectionId,
      expect.objectContaining({ accessToken: 'freshly-exchanged-access-token' }),
    );
  });

  it('throws (never silently proceeds with no token) when the token-refresh HTTP call itself fails', async () => {
    const connectionId = 'expired-conn-2';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredStoredCredential());

    vi.mocked(apiFetch).mockResolvedValue({
      status: 400,
      ok: false,
      body: { error: 'invalid_grant' },
    });

    const err = await createListing(baseInput({ connectionId })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).platform).toBe('etsy');
    expect((err as ConnectorPlatformError).code).toBe('oauth_400');
    // Only the failed token-exchange call happened -- the listing API must
    // never be reached with no valid token.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(rotateCredential).not.toHaveBeenCalled();
  });

  it('scrubs the api key/shared secret out of the thrown message on a failed token-refresh call', async () => {
    const connectionId = 'expired-conn-2b';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredStoredCredential());

    vi.mocked(apiFetch).mockResolvedValue({
      status: 400,
      ok: false,
      body: { error: `invalid_grant, secret was ${ETSY_SHARED_SECRET}` },
    });

    const err = await createListing(baseInput({ connectionId })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).message).not.toContain(ETSY_SHARED_SECRET);
  });

  it('throws oauth_bad_response (a different code path than getFreshAccessToken\'s stored-credential shape check) when the exchange call succeeds but the response is missing access_token', async () => {
    const connectionId = 'expired-conn-3';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredStoredCredential());

    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { expires_in: 3600, token_type: 'Bearer' },
    });

    const err = await createListing(baseInput({ connectionId })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).platform).toBe('etsy');
    expect((err as ConnectorPlatformError).code).toBe('oauth_bad_response');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(rotateCredential).not.toHaveBeenCalled();
  });

  it('throws oauth_bad_response when the exchange call succeeds but expires_in is not a number', async () => {
    const connectionId = 'expired-conn-4';
    vi.mocked(getDecryptedCredential).mockReturnValue(expiredStoredCredential());

    vi.mocked(apiFetch).mockResolvedValue({
      status: 200,
      ok: true,
      body: { access_token: 'tok', expires_in: '3600', token_type: 'Bearer' },
    });

    const err = await createListing(baseInput({ connectionId })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect((err as ConnectorPlatformError).code).toBe('oauth_bad_response');
  });
});
