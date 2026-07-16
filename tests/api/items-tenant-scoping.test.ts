import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as itemsGET, POST as itemsPOST } from '@/app/api/items/route';
import { GET as itemGET, PATCH as itemPATCH } from '@/app/api/items/[id]/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Throwaway verification for Task 15 (retrofit /api/items core routes with
// tenant_id filtering). NOT a substitute for Task 22's full acceptance
// suite -- this only exercises the specific behaviors the review caught:
// unauthenticated 401s, cross-tenant 404s, and the "no filters supplied"
// GET still scoping to the caller's own tenant.
// ---------------------------------------------------------------------------

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function listRequest(query = '', cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/items${query}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function createRequest(body: unknown, cookie?: string): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getByIdRequest(id: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/${id}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

function patchRequest(id: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function validBook(overrides: Record<string, unknown> = {}) {
  return {
    category: 'book',
    title: 'Tenant Scoping Test Book',
    author: 'Some Author',
    publisher: 'Some Publisher',
    condition: 'Good',
    acquisition_cost: 500,
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

describe('tenant scoping: /api/items and /api/items/[id]', () => {
  it('rejects unauthenticated GET /api/items with 401', async () => {
    const res = await itemsGET(listRequest());
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated POST /api/items with 401', async () => {
    const res = await itemsPOST(createRequest(validBook()));
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated GET /api/items/:id with 401', async () => {
    const res = await itemGET(getByIdRequest('11111111-1111-4111-8111-111111111111'), params('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated PATCH /api/items/:id with 401', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const res = await itemPATCH(patchRequest(id, { condition: 'Good' }), params(id));
    expect(res.status).toBe(401);
  });

  it('lets an authenticated tenant create, list, get, and update their own item exactly as before', async () => {
    const tenant = createTestTenant();

    const createRes = await itemsPOST(createRequest(validBook(), tenant.cookieHeader));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const id = created.id as string;

    const listRes = await itemsGET(listRequest('', tenant.cookieHeader));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.items.some((i: { id: string }) => i.id === id)).toBe(true);

    const getRes = await itemGET(getByIdRequest(id, tenant.cookieHeader), params(id));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.id).toBe(id);

    const patchRes = await itemPATCH(
      patchRequest(id, { condition: 'Very Good' }, tenant.cookieHeader),
      params(id),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.details.condition).toBe('Very Good');
  });

  // A non-default tenant (tenants.id != the migrated seed tenant) is the
  // case that actually exercises migration 006's tenant-match triggers on
  // price_history and item_platforms -- these writes live inside this
  // task's file and must carry tenant_id or the trigger raises and the
  // whole PATCH 500s.
  it('lets an authenticated (non-default) tenant set listing_price and platforms without tripping the tenant-match trigger', async () => {
    const tenant = createTestTenant();

    const createRes = await itemsPOST(createRequest(validBook(), tenant.cookieHeader));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const id = created.id as string;

    const patchRes = await itemPATCH(
      patchRequest(id, { listing_price: 1999, platforms: ['ebay', 'poshmark'] }, tenant.cookieHeader),
      params(id),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.listing_price).toBe(1999);
    expect(patchBody.platforms.sort()).toEqual(['ebay', 'poshmark']);

    const getRes = await itemGET(getByIdRequest(id, tenant.cookieHeader), params(id));
    const getBody = await getRes.json();
    expect(getBody.price_history.length).toBeGreaterThan(0);
  });

  it('returns 404 (not 403, not the resource) when a second tenant tries to GET or PATCH the first tenant\'s item', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    const createRes = await itemsPOST(createRequest(validBook(), tenantA.cookieHeader));
    const created = await createRes.json();
    const id = created.id as string;

    const crossGetRes = await itemGET(getByIdRequest(id, tenantB.cookieHeader), params(id));
    expect(crossGetRes.status).toBe(404);

    const crossPatchRes = await itemPATCH(
      patchRequest(id, { condition: 'Fair' }, tenantB.cookieHeader),
      params(id),
    );
    expect(crossPatchRes.status).toBe(404);
  });

  it('GET /api/items with NO filters supplied only returns the authenticated tenant\'s own items, not another tenant\'s', async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();

    const createA = await itemsPOST(
      createRequest(validBook({ title: 'Tenant A Exclusive Book' }), tenantA.cookieHeader),
    );
    expect(createA.status).toBe(201);
    const itemA = await createA.json();

    const createB = await itemsPOST(
      createRequest(validBook({ title: 'Tenant B Exclusive Book' }), tenantB.cookieHeader),
    );
    expect(createB.status).toBe(201);
    const itemB = await createB.json();

    // No query params at all -- the exact "no filters supplied" case the
    // review flagged: filterClauses must still be seeded with tenant_id
    // even though the caller passed nothing else.
    const listResA = await itemsGET(listRequest('', tenantA.cookieHeader));
    expect(listResA.status).toBe(200);
    const listBodyA = await listResA.json();
    const idsA = listBodyA.items.map((i: { id: string }) => i.id);
    expect(idsA).toContain(itemA.id);
    expect(idsA).not.toContain(itemB.id);

    const listResB = await itemsGET(listRequest('', tenantB.cookieHeader));
    expect(listResB.status).toBe(200);
    const listBodyB = await listResB.json();
    const idsB = listBodyB.items.map((i: { id: string }) => i.id);
    expect(idsB).toContain(itemB.id);
    expect(idsB).not.toContain(itemA.id);
  });
});
