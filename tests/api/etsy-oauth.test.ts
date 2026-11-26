import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/connectors/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/connectors/apiFetch';
import { POST as authorizePOST } from '@/app/api/connections/[id]/etsy/authorize/route';
import { GET as callbackGET } from '@/app/api/oauth/etsy/callback/route';
import { createConnection, getDecryptedCredential } from '@/lib/connections';
import { createTestTenant } from '../tenantFixtures';

const ENV = {
  ETSY_API_KEY: 'etsy-key',
  ETSY_SHARED_SECRET: 'etsy-secret',
  ETSY_REDIRECT_URI: 'http://127.0.0.1:3000/api/oauth/etsy/callback',
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
function authorizeReq(id: string, cookie?: string) {
  return new NextRequest(`http://localhost/api/connections/${id}/etsy/authorize`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}
function callbackReq(query: string, cookie?: string) {
  return new NextRequest(`http://localhost/api/oauth/etsy/callback?${query}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}
function etsyConn(tenantId: string, platform = 'etsy') {
  return createConnection(tenantId, platform, {
    accessToken: 'placeholder',
    expiresAt: 0,
    refreshToken: 'placeholder',
  });
}

describe('POST /api/connections/:id/etsy/authorize', () => {
  it('401 without a session', async () => {
    const t = createTestTenant();
    const conn = etsyConn(t.tenantId);
    const res = await authorizePOST(authorizeReq(conn.id), params(conn.id));
    expect(res.status).toBe(401);
  });

  it("404 for another tenant's connection", async () => {
    const owner = createTestTenant();
    const other = createTestTenant();
    const conn = etsyConn(owner.tenantId);
    const res = await authorizePOST(authorizeReq(conn.id, other.cookieHeader), params(conn.id));
    expect(res.status).toBe(404);
  });

  it('422 when the connection is not an Etsy connection', async () => {
    const t = createTestTenant();
    const conn = etsyConn(t.tenantId, 'ebay');
    const res = await authorizePOST(authorizeReq(conn.id, t.cookieHeader), params(conn.id));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not_an_etsy_connection');
  });

  it('503 connector_not_configured when ETSY_REDIRECT_URI is missing', async () => {
    delete process.env.ETSY_REDIRECT_URI;
    const t = createTestTenant();
    const conn = etsyConn(t.tenantId);
    const res = await authorizePOST(authorizeReq(conn.id, t.cookieHeader), params(conn.id));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('connector_not_configured');
  });

  it('200 with an Etsy authorizeUrl', async () => {
    const t = createTestTenant();
    const conn = etsyConn(t.tenantId);
    const res = await authorizePOST(authorizeReq(conn.id, t.cookieHeader), params(conn.id));
    expect(res.status).toBe(200);
    const { authorizeUrl } = await res.json();
    expect(authorizeUrl).toMatch(/^https:\/\/www\.etsy\.com\/oauth\/connect\?/);
  });
});

async function startFlow() {
  const t = createTestTenant();
  const conn = etsyConn(t.tenantId);
  const res = await authorizePOST(authorizeReq(conn.id, t.cookieHeader), params(conn.id));
  const { authorizeUrl } = await res.json();
  return { t, conn, state: new URL(authorizeUrl).searchParams.get('state') as string };
}

describe('GET /api/oauth/etsy/callback › auth, state and denial', () => {
  it('401 without a session', async () => {
    const res = await callbackGET(callbackReq('code=c&state=s'));
    expect(res.status).toBe(401);
  });

  it('400 invalid_state for an unknown state', async () => {
    const t = createTestTenant();
    const res = await callbackGET(callbackReq('code=c&state=unknown', t.cookieHeader));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_state');
  });

  it('redirects to /connections?etsy=denied when the user declines on Etsy', async () => {
    const { t, state } = await startFlow();
    const res = await callbackGET(
      callbackReq(`error=access_denied&state=${state}`, t.cookieHeader),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/connections');
    expect(res.headers.get('location')).toContain('etsy=denied');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/oauth/etsy/callback › success and cross-tenant flows', () => {
  it('stores the credential and redirects to /connections?etsy=connected on success', async () => {
    const { t, conn, state } = await startFlow();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: { access_token: '42.tok', refresh_token: '42.ref', expires_in: 3600, token_type: 'Bearer' },
      })
      .mockResolvedValueOnce({ status: 200, ok: true, body: { count: 1, results: [{ shop_id: 555 }] } });

    const res = await callbackGET(callbackReq(`code=abc&state=${state}`, t.cookieHeader));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/connections');
    expect(res.headers.get('location')).toContain('etsy=connected');
    const stored = getDecryptedCredential(t.tenantId, conn.id) as Record<string, unknown>;
    expect(stored.shopId).toBe('555');
    expect(stored.accessToken).toBe('42.tok');
  });

  it("another tenant cannot complete someone else's flow", async () => {
    const { state } = await startFlow();
    const attacker = createTestTenant();
    const res = await callbackGET(callbackReq(`code=abc&state=${state}`, attacker.cookieHeader));
    expect(res.status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
