import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

vi.mock('@/lib/connectors/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/connectors/apiFetch';
import {
  generatePkce,
  startEtsyAuthorization,
  completeEtsyAuthorization,
  EtsyAuthError,
} from '@/lib/etsyAuth';
import { createConnection, getDecryptedCredential } from '@/lib/connections';
import { ConnectorNotConfiguredError } from '@/lib/connectors/types';
import { createTestTenant } from '../../tests/helpers/tenant';

const ENV = {
  ETSY_API_KEY: 'etsy-key',
  ETSY_SHARED_SECRET: 'etsy-secret',
  ETSY_REDIRECT_URI: 'http://127.0.0.1:3000/api/oauth/etsy/callback',
};
const saved: Record<string, string | undefined> = {};

function newEtsyConnection() {
  const tenant = createTestTenant();
  const conn = createConnection(tenant.tenantId, 'etsy', {
    accessToken: 'placeholder',
    expiresAt: 0,
    refreshToken: 'placeholder',
  });
  return { tenant, conn };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') as string;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('generatePkce', () => {
  it('returns a base64url verifier of 43-128 chars and its S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('is random per call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe('startEtsyAuthorization', () => {
  it('builds the Etsy connect URL with PKCE S256, the redirect URI and the needed scopes', () => {
    const { tenant, conn } = newEtsyConnection();
    const url = new URL(startEtsyAuthorization(tenant.tenantId, conn.id));

    expect(url.origin + url.pathname).toBe('https://www.etsy.com/oauth/connect');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('etsy-key');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.ETSY_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toEqual(expect.arrayContaining(['listings_r', 'listings_w', 'shops_r']));
  });

  it('throws ConnectorNotConfiguredError when ETSY_REDIRECT_URI is not set', () => {
    delete process.env.ETSY_REDIRECT_URI;
    const { tenant, conn } = newEtsyConnection();
    expect(() => startEtsyAuthorization(tenant.tenantId, conn.id)).toThrow(
      ConnectorNotConfiguredError,
    );
  });
});

function mockEtsy() {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: {
        access_token: '12345678.abcdef',
        refresh_token: '12345678.refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    })
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { count: 1, results: [{ shop_id: 987654 }] },
    });
}

describe('completeEtsyAuthorization', () => {
  it('exchanges the code with the PKCE verifier, looks up the shop, and stores the credential', async () => {
    const { tenant, conn } = newEtsyConnection();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));
    mockEtsy();

    const result = await completeEtsyAuthorization(tenant.tenantId, 'auth-code', state);
    expect(result).toEqual({ connectionId: conn.id });

    const [tokenUrl, tokenOpts] = vi.mocked(apiFetch).mock.calls[0];
    expect(tokenUrl).toBe('https://api.etsy.com/v3/public/oauth/token');
    expect(tokenOpts?.body).toBeUndefined();
    expect(tokenOpts?.form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'etsy-key',
      redirect_uri: ENV.ETSY_REDIRECT_URI,
      code: 'auth-code',
    });
    // The verifier sent must hash to the challenge in the authorize URL.
    const verifier = tokenOpts?.form?.code_verifier as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const [shopUrl, shopOpts] = vi.mocked(apiFetch).mock.calls[1];
    expect(shopUrl).toBe('https://api.etsy.com/v3/application/users/12345678/shops');
    expect(shopOpts?.headers?.Authorization).toBe('Bearer 12345678.abcdef');
    expect(shopOpts?.headers?.['x-api-key']).toBe('etsy-key');

    const stored = getDecryptedCredential(tenant.tenantId, conn.id) as Record<string, unknown>;
    expect(stored).toMatchObject({
      accessToken: '12345678.abcdef',
      refreshToken: '12345678.refresh',
      shopId: '987654',
    });
    expect(typeof stored.expiresAt).toBe('number');
  });

  it('sends a verifier whose S256 hash equals the challenge in the authorize URL', async () => {
    const { tenant, conn } = newEtsyConnection();
    const url = new URL(startEtsyAuthorization(tenant.tenantId, conn.id));
    mockEtsy();

    await completeEtsyAuthorization(tenant.tenantId, 'c', url.searchParams.get('state') as string);

    const verifier = vi.mocked(apiFetch).mock.calls[0][1]?.form?.code_verifier as string;
    const hashed = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(hashed).toBe(url.searchParams.get('code_challenge'));
  });
});

describe('completeEtsyAuthorization', () => {
  it('rejects an unknown state', async () => {
    const { tenant } = newEtsyConnection();
    await expect(completeEtsyAuthorization(tenant.tenantId, 'c', 'nope')).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('makes state single-use', async () => {
    const { tenant, conn } = newEtsyConnection();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));
    mockEtsy();
    await completeEtsyAuthorization(tenant.tenantId, 'c', state);

    await expect(completeEtsyAuthorization(tenant.tenantId, 'c', state)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it("rejects another tenant's state", async () => {
    const { tenant, conn } = newEtsyConnection();
    const other = createTestTenant();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));

    await expect(completeEtsyAuthorization(other.tenantId, 'c', state)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects state older than 10 minutes', async () => {
    vi.useFakeTimers();
    const { tenant, conn } = newEtsyConnection();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    await expect(completeEtsyAuthorization(tenant.tenantId, 'c', state)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });
});

describe('completeEtsyAuthorization', () => {
  it('surfaces a token-exchange failure without leaking the code, verifier or secrets', async () => {
    const { tenant, conn } = newEtsyConnection();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));
    vi.mocked(apiFetch).mockResolvedValueOnce({
      status: 400,
      ok: false,
      body: { error: 'invalid_grant', detail: 'bad auth-code-123 etsy-secret' },
    });

    const err = await completeEtsyAuthorization(tenant.tenantId, 'auth-code-123', state).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(EtsyAuthError);
    expect(err.code).toBe('token_exchange_failed');
    expect(err.message).not.toContain('auth-code-123');
    expect(err.message).not.toContain('etsy-secret');
  });

  it('fails with shop_not_found when the user has no shop, and stores nothing', async () => {
    const { tenant, conn } = newEtsyConnection();
    const state = stateOf(startEtsyAuthorization(tenant.tenantId, conn.id));
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { access_token: '1.a', refresh_token: '1.r', expires_in: 3600, token_type: 'Bearer' },
      })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { count: 0, results: [] } });

    await expect(completeEtsyAuthorization(tenant.tenantId, 'c', state)).rejects.toMatchObject({
      code: 'shop_not_found',
    });
    const stored = getDecryptedCredential(tenant.tenantId, conn.id) as Record<string, unknown>;
    expect(stored.accessToken).toBe('placeholder');
  });
});
