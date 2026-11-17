import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ebayExchangeFn/getEbayAccessToken's transport dependency is apiFetch --
// mocked at the module boundary so this file tests only the OAuth
// request-shaping logic in ebay.ts, not apiFetch.ts's own retry/timeout
// behavior (that's covered by apiFetch.test.ts).
vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../apiFetch';
import { getEbayBaseUrl, ebayExchangeFn } from '../ebay';
import { ConnectorNotConfiguredError } from '../types';

const CLIENT_ID_VAR = 'EBAY_SANDBOX_CLIENT_ID';
const CLIENT_SECRET_VAR = 'EBAY_SANDBOX_CLIENT_SECRET';

describe('getEbayBaseUrl', () => {
  const originalEnv = process.env.EBAY_ENV;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EBAY_ENV;
    } else {
      process.env.EBAY_ENV = originalEnv;
    }
  });

  it('defaults to the sandbox base URL when EBAY_ENV is unset', () => {
    delete process.env.EBAY_ENV;

    expect(getEbayBaseUrl()).toBe('https://api.sandbox.ebay.com');
  });

  it('returns the sandbox base URL when EBAY_ENV is explicitly "sandbox"', () => {
    process.env.EBAY_ENV = 'sandbox';

    expect(getEbayBaseUrl()).toBe('https://api.sandbox.ebay.com');
  });

  it('returns the production base URL only when EBAY_ENV is explicitly "production"', () => {
    process.env.EBAY_ENV = 'production';

    expect(getEbayBaseUrl()).toBe('https://api.ebay.com');
  });

  it('throws rather than guessing for any other EBAY_ENV value', () => {
    process.env.EBAY_ENV = 'staging';

    expect(() => getEbayBaseUrl()).toThrow(/staging/);
  });
});

const originalClientId = process.env[CLIENT_ID_VAR];

const originalClientSecret = process.env[CLIENT_SECRET_VAR];

const beforeEachEbayExchangeFn = () => {
  vi.mocked(apiFetch).mockReset();
  process.env[CLIENT_ID_VAR] = 'test-client-id';
  process.env[CLIENT_SECRET_VAR] = 'test-client-secret';
};

const afterEachEbayExchangeFn = () => {
  if (originalClientId === undefined) {
    delete process.env[CLIENT_ID_VAR];
  } else {
    process.env[CLIENT_ID_VAR] = originalClientId;
  }
  if (originalClientSecret === undefined) {
    delete process.env[CLIENT_SECRET_VAR];
  } else {
    process.env[CLIENT_SECRET_VAR] = originalClientSecret;
  }
};

describe('ebayExchangeFn', () => {
  beforeEach(beforeEachEbayExchangeFn);
  afterEach(afterEachEbayExchangeFn);

  it('POSTs to the eBay Sandbox token endpoint with a Basic-auth header and the refresh_token grant params', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        access_token: 'new-access-token',
        expires_in: 7200,
        refresh_token: 'new-refresh-token',
        token_type: 'Bearer',
      },
    });

    const result = await ebayExchangeFn('old-refresh-token');

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token');
    expect(options?.method).toBe('POST');

    const expectedBasicAuth = Buffer.from('test-client-id:test-client-secret').toString('base64');
    expect(options?.headers?.Authorization).toBe(`Basic ${expectedBasicAuth}`);

    // eBay's token endpoint requires application/x-www-form-urlencoded, so
    // the grant params go in `form`, never the JSON `body`.
    expect(options?.body).toBeUndefined();
    expect(options?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    });

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    // expiresAt should be ~7200s (expires_in) from now, in epoch ms.
    const expectedExpiresAt = Date.now() + 7200 * 1000;
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(Math.abs(result.expiresAt - expectedExpiresAt)).toBeLessThan(5000);
  });
});

describe('ebayExchangeFn', () => {
  beforeEach(beforeEachEbayExchangeFn);
  afterEach(afterEachEbayExchangeFn);

  it('throws ConnectorNotConfiguredError when EBAY_SANDBOX_CLIENT_ID is missing', async () => {
    delete process.env[CLIENT_ID_VAR];

    let thrown: unknown;
    try {
      await ebayExchangeFn('old-refresh-token');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorNotConfiguredError);
    expect((thrown as ConnectorNotConfiguredError).platform).toBe('ebay');
    expect((thrown as ConnectorNotConfiguredError).missingVar).toBe(CLIENT_ID_VAR);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws ConnectorNotConfiguredError when EBAY_SANDBOX_CLIENT_SECRET is missing', async () => {
    delete process.env[CLIENT_SECRET_VAR];

    let thrown: unknown;
    try {
      await ebayExchangeFn('old-refresh-token');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConnectorNotConfiguredError);
    expect((thrown as ConnectorNotConfiguredError).platform).toBe('ebay');
    expect((thrown as ConnectorNotConfiguredError).missingVar).toBe(CLIENT_SECRET_VAR);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('throws when apiFetch returns a non-ok response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 400,
      ok: false,
      body: { error: 'invalid_grant' },
    });

    await expect(ebayExchangeFn('old-refresh-token')).rejects.toThrow(/400/);
  });
});

describe('ebayExchangeFn', () => {
  beforeEach(beforeEachEbayExchangeFn);
  afterEach(afterEachEbayExchangeFn);

  it('throws a generic Error when apiFetch returns ok:true but the response is missing access_token', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { expires_in: 7200, token_type: 'Bearer' },
    });

    await expect(ebayExchangeFn('old-refresh-token')).rejects.toThrow(/unexpected response shape/);
  });

  it('throws a generic Error when apiFetch returns ok:true but expires_in is not a number', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { access_token: 'tok', expires_in: '7200', token_type: 'Bearer' },
    });

    await expect(ebayExchangeFn('old-refresh-token')).rejects.toThrow(/unexpected response shape/);
  });

  it('throws when apiFetch returns ok:true but the body is null', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ status: 200, ok: true, body: null });

    await expect(ebayExchangeFn('old-refresh-token')).rejects.toThrow(/unexpected response shape/);
  });
});

describe('ebayExchangeFn in production', () => {
  const saved: Record<string, string | undefined> = {};
  const vars = ['EBAY_ENV', 'EBAY_PRODUCTION_CLIENT_ID', 'EBAY_PRODUCTION_CLIENT_SECRET'];

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    for (const v of vars) saved[v] = process.env[v];
    process.env.EBAY_ENV = 'production';
    process.env.EBAY_PRODUCTION_CLIENT_ID = 'prod-id';
    process.env.EBAY_PRODUCTION_CLIENT_SECRET = 'prod-secret';
  });

  afterEach(() => {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('uses the production token endpoint and the production client credentials', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { access_token: 'a', expires_in: 7200, token_type: 'Bearer' },
    });

    await ebayExchangeFn('rt');

    const [url, options] = vi.mocked(apiFetch).mock.calls[0];
    expect(url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    const basic = Buffer.from('prod-id:prod-secret').toString('base64');
    expect(options?.headers?.Authorization).toBe(`Basic ${basic}`);
  });

  it('never falls back to the sandbox credentials when the production ones are missing', async () => {
    delete process.env.EBAY_PRODUCTION_CLIENT_ID;
    process.env.EBAY_SANDBOX_CLIENT_ID = 'sandbox-id';
    process.env.EBAY_SANDBOX_CLIENT_SECRET = 'sandbox-secret';

    await expect(ebayExchangeFn('rt')).rejects.toBeInstanceOf(ConnectorNotConfiguredError);
    expect(apiFetch).not.toHaveBeenCalled();
    delete process.env.EBAY_SANDBOX_CLIENT_ID;
    delete process.env.EBAY_SANDBOX_CLIENT_SECRET;
  });
});
