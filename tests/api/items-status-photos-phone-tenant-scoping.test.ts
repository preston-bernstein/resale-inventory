import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { POST as statusPOST } from '@/app/api/items/[id]/status/route';
import { POST as photosPOST, PATCH as photosPATCH } from '@/app/api/items/[id]/photos/route';
import { GET as photoGET, DELETE as photoDELETE } from '@/app/api/items/[id]/photos/[photoId]/route';
import {
  POST as phoneSessionPOST,
  GET as phoneSessionGET,
  DELETE as phoneSessionDELETE,
} from '@/app/api/items/[id]/phone-session/route';
import { createToken } from '@/lib/pairingToken';
import { createTestTenant } from '../fixtures/tenant';

// ---------------------------------------------------------------------------
// Throwaway verification for Task 17 (retrofit /api/items status and photos
// routes with tenant_id filtering). NOT a substitute for Task 22's full
// acceptance suite -- this only exercises the specific behaviors the task
// called out: unauthenticated 401s, cross-tenant 404s across all four
// routes, an authenticated tenant's own-item flow working exactly as
// before, and the X-Pairing-Token upload path from Task 16 remaining
// completely unaffected (no session cookie, still succeeds).
// ---------------------------------------------------------------------------

const TAILNET_HOST = 'myapp.beta.ts.net';

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function photoParams(id: string, photoId: string) {
  return { params: Promise.resolve({ id, photoId }) };
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function tinyPngFormData(): FormData {
  const fd = new FormData();
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  fd.append('files', new File([bytes], 'photo.png', { type: 'image/png' }));
  return fd;
}

function insertClothingItem(tenantId: string): string {
  const id = uuidv4();
  const item = {
    id,
    category: 'clothing',
    title: 'Scoping Test Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'TestBrand',
    size_label: 'M',
    condition: 'EUC',
    tenant_id: tenantId,
  };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
  db.prepare(`
    INSERT INTO clothing_details (item_id, brand, size_label, condition, tenant_id)
    VALUES (@id, @brand, @size_label, @condition, @tenant_id)
  `).run(item);
  return id;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function itemUrl(id: string, suffix = '') {
  return `http://localhost/api/items/${id}${suffix}`;
}

function withCookie(headers: Record<string, string>, cookie?: string) {
  return cookie ? { ...headers, Cookie: cookie } : headers;
}

function callStatus(id: string, cookie?: string) {
  return statusPOST(
    new NextRequest(itemUrl(id, '/status'), {
      method: 'POST',
      headers: withCookie(JSON_HEADERS, cookie),
      body: JSON.stringify({ status: 'Donated' }),
    }),
    params(id),
  );
}

function callUpload(id: string, cookie?: string) {
  return photosPOST(
    new NextRequest(itemUrl(id, '/photos'), {
      method: 'POST',
      body: tinyPngFormData(),
      headers: withCookie({}, cookie),
    }),
    params(id),
  );
}

function callReorder(id: string, order: string[], cookie?: string) {
  return photosPATCH(
    new NextRequest(itemUrl(id, '/photos'), {
      method: 'PATCH',
      headers: withCookie(JSON_HEADERS, cookie),
      body: JSON.stringify({ order }),
    }),
    params(id),
  );
}

function callPhotoGet(id: string, photoId: string, cookie?: string) {
  return photoGET(
    new NextRequest(itemUrl(id, `/photos/${photoId}`), { headers: withCookie({}, cookie) }),
    photoParams(id, photoId),
  );
}

function callPhotoDelete(id: string, photoId: string, cookie?: string) {
  return photoDELETE(
    new NextRequest(itemUrl(id, `/photos/${photoId}`), {
      method: 'DELETE',
      headers: withCookie({}, cookie),
    }),
    photoParams(id, photoId),
  );
}

function callPhoneSessionPost(id: string, cookie?: string) {
  return phoneSessionPOST(
    new NextRequest(itemUrl(id, '/phone-session'), {
      method: 'POST',
      headers: withCookie({ host: TAILNET_HOST }, cookie),
    }),
    params(id),
  );
}

function callPhoneSessionGet(id: string, cookie?: string) {
  return phoneSessionGET(
    new NextRequest(itemUrl(id, '/phone-session'), { headers: withCookie({}, cookie) }),
    params(id),
  );
}

function callPhoneSessionDelete(id: string, cookie?: string) {
  return phoneSessionDELETE(
    new NextRequest(itemUrl(id, '/phone-session'), {
      method: 'DELETE',
      headers: withCookie({}, cookie),
    }),
    params(id),
  );
}

async function expectStatus(response: Promise<Response>, status: number) {
  expect((await response).status).toBe(status);
}

async function uploadPhotoAs(id: string, cookie: string) {
  const res = await callUpload(id, cookie);
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.photos[0].id as string;
}

describe('tenant scoping: status, photos, photos/[photoId], phone-session', () => {
  it('rejects unauthenticated requests to all four routes with 401', async () => {
    const tenant = createTestTenant();
    const id = insertClothingItem(tenant.tenantId);
    const photoId = uuidv4();

    await expectStatus(callStatus(id), 401);
    await expectStatus(callUpload(id), 401);
    await expectStatus(callReorder(id, []), 401);
    await expectStatus(callPhotoGet(id, photoId), 401);
    await expectStatus(callPhotoDelete(id, photoId), 401);
    await expectStatus(callPhoneSessionPost(id), 401);
    await expectStatus(callPhoneSessionGet(id), 401);
    await expectStatus(callPhoneSessionDelete(id), 401);
  });

  it("lets an authenticated tenant mutate their own item's status/photos/phone-session exactly as before", async () => {
    const tenant = createTestTenant();
    const id = insertClothingItem(tenant.tenantId);
    const cookie = tenant.cookieHeader;

    await expectStatus(callStatus(id, cookie), 200);
    const photoId = await uploadPhotoAs(id, cookie);
    await expectStatus(callPhotoGet(id, photoId, cookie), 200);
    await expectStatus(callReorder(id, [photoId], cookie), 200);
    await expectStatus(callPhoneSessionPost(id, cookie), 201);
    await expectStatus(callPhoneSessionGet(id, cookie), 200);
    await expectStatus(callPhoneSessionDelete(id, cookie), 204);
    await expectStatus(callPhotoDelete(id, photoId, cookie), 200);
  });
});

describe('tenant scoping: status, photos, photos/[photoId], phone-session', () => {
  it("returns 404 (not the resource) when a second tenant tries to mutate the first tenant's item via any of these routes", async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const id = insertClothingItem(tenantA.tenantId);
    const intruder = tenantB.cookieHeader;

    await expectStatus(callStatus(id, intruder), 404);
    await expectStatus(callUpload(id, intruder), 404);
    await expectStatus(callReorder(id, [], intruder), 404);
    await expectStatus(callPhoneSessionPost(id, intruder), 404);
    await expectStatus(callPhoneSessionGet(id, intruder), 404);
    await expectStatus(callPhoneSessionDelete(id, intruder), 404);

    // Upload a real photo as the owning tenant so a real photoId exists to
    // probe GET/DELETE cross-tenant against.
    const photoId = await uploadPhotoAs(id, tenantA.cookieHeader);

    await expectStatus(callPhotoGet(id, photoId, intruder), 404);
    await expectStatus(callPhotoDelete(id, photoId, intruder), 404);

    // Tenant A's photo row and item status must be entirely untouched by
    // every rejected cross-tenant attempt above.
    const photoRow = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(photoRow).toBeTruthy();
    const itemRow = db.prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string };
    expect(itemRow.status).toBe('Unlisted');
  });
});

describe('tenant scoping: status, photos, photos/[photoId], phone-session', () => {
  it('the X-Pairing-Token upload path from Task 16 still works completely unaffected -- no session cookie, still succeeds', async () => {
    const tenant = createTestTenant();
    const id = insertClothingItem(tenant.tenantId);
    const { token } = createToken(id);

    const req = new NextRequest(`http://localhost/api/items/${id}/photos`, {
      method: 'POST',
      body: tinyPngFormData(),
      headers: { 'X-Pairing-Token': token }, // deliberately no Cookie header at all
    });
    const res = await photosPOST(req, params(id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.photos).toHaveLength(1);

    // tenant_id on the inserted row still comes from the item, not the
    // (absent) session -- Task 16's fix, unaffected by this task's retrofit.
    const row = db.prepare('SELECT tenant_id FROM item_photos WHERE item_id = ?').get(id) as {
      tenant_id: string;
    };
    expect(row.tenant_id).toBe(tenant.tenantId);
  });
});
