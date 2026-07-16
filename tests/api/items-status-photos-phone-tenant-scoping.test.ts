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
import { createTestTenant } from '../helpers/tenant';

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

describe('tenant scoping: status, photos, photos/[photoId], phone-session', () => {
  it('rejects unauthenticated requests to all four routes with 401', async () => {
    const tenant = createTestTenant();
    const id = insertClothingItem(tenant.tenantId);
    const photoId = uuidv4();

    const statusRes = await statusPOST(
      new NextRequest(`http://localhost/api/items/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Donated' }),
      }),
      params(id),
    );
    expect(statusRes.status).toBe(401);

    const photosPostRes = await photosPOST(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'POST',
        body: tinyPngFormData(),
      }),
      params(id),
    );
    expect(photosPostRes.status).toBe(401);

    const photosPatchRes = await photosPATCH(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: [] }),
      }),
      params(id),
    );
    expect(photosPatchRes.status).toBe(401);

    const photoGetRes = await photoGET(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`),
      photoParams(id, photoId),
    );
    expect(photoGetRes.status).toBe(401);

    const photoDeleteRes = await photoDELETE(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`, { method: 'DELETE' }),
      photoParams(id, photoId),
    );
    expect(photoDeleteRes.status).toBe(401);

    const phonePostRes = await phoneSessionPOST(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        method: 'POST',
        headers: { host: TAILNET_HOST },
      }),
      params(id),
    );
    expect(phonePostRes.status).toBe(401);

    const phoneGetRes = await phoneSessionGET(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`),
      params(id),
    );
    expect(phoneGetRes.status).toBe(401);

    const phoneDeleteRes = await phoneSessionDELETE(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, { method: 'DELETE' }),
      params(id),
    );
    expect(phoneDeleteRes.status).toBe(401);
  });

  it("lets an authenticated tenant mutate their own item's status/photos/phone-session exactly as before", async () => {
    const tenant = createTestTenant();
    const id = insertClothingItem(tenant.tenantId);
    const cookie = tenant.cookieHeader;

    const statusRes = await statusPOST(
      new NextRequest(`http://localhost/api/items/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ status: 'Donated' }),
      }),
      params(id),
    );
    expect(statusRes.status).toBe(200);

    const uploadRes = await photosPOST(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'POST',
        body: tinyPngFormData(),
        headers: { Cookie: cookie },
      }),
      params(id),
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    const photoId = uploadBody.photos[0].id as string;

    const photoGetRes = await photoGET(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`, {
        headers: { Cookie: cookie },
      }),
      photoParams(id, photoId),
    );
    expect(photoGetRes.status).toBe(200);

    const reorderRes = await photosPATCH(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ order: [photoId] }),
      }),
      params(id),
    );
    expect(reorderRes.status).toBe(200);

    const phonePostRes = await phoneSessionPOST(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        method: 'POST',
        headers: { host: TAILNET_HOST, Cookie: cookie },
      }),
      params(id),
    );
    expect(phonePostRes.status).toBe(201);

    const phoneGetRes = await phoneSessionGET(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        headers: { Cookie: cookie },
      }),
      params(id),
    );
    expect(phoneGetRes.status).toBe(200);

    const phoneDeleteRes = await phoneSessionDELETE(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      params(id),
    );
    expect(phoneDeleteRes.status).toBe(204);

    const photoDeleteRes = await photoDELETE(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      }),
      photoParams(id, photoId),
    );
    expect(photoDeleteRes.status).toBe(200);
  });

  it("returns 404 (not the resource) when a second tenant tries to mutate the first tenant's item via any of these routes", async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const id = insertClothingItem(tenantA.tenantId);

    const statusRes = await statusPOST(
      new NextRequest(`http://localhost/api/items/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: tenantB.cookieHeader },
        body: JSON.stringify({ status: 'Donated' }),
      }),
      params(id),
    );
    expect(statusRes.status).toBe(404);

    const crossUploadRes = await photosPOST(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'POST',
        body: tinyPngFormData(),
        headers: { Cookie: tenantB.cookieHeader },
      }),
      params(id),
    );
    expect(crossUploadRes.status).toBe(404);

    const patchRes = await photosPATCH(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: tenantB.cookieHeader },
        body: JSON.stringify({ order: [] }),
      }),
      params(id),
    );
    expect(patchRes.status).toBe(404);

    const phonePostRes = await phoneSessionPOST(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        method: 'POST',
        headers: { host: TAILNET_HOST, Cookie: tenantB.cookieHeader },
      }),
      params(id),
    );
    expect(phonePostRes.status).toBe(404);

    const phoneGetRes = await phoneSessionGET(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        headers: { Cookie: tenantB.cookieHeader },
      }),
      params(id),
    );
    expect(phoneGetRes.status).toBe(404);

    const phoneDeleteRes = await phoneSessionDELETE(
      new NextRequest(`http://localhost/api/items/${id}/phone-session`, {
        method: 'DELETE',
        headers: { Cookie: tenantB.cookieHeader },
      }),
      params(id),
    );
    expect(phoneDeleteRes.status).toBe(404);

    // Upload a real photo as the owning tenant so a real photoId exists to
    // probe GET/DELETE cross-tenant against.
    const realUploadRes = await photosPOST(
      new NextRequest(`http://localhost/api/items/${id}/photos`, {
        method: 'POST',
        body: tinyPngFormData(),
        headers: { Cookie: tenantA.cookieHeader },
      }),
      params(id),
    );
    expect(realUploadRes.status).toBe(201);
    const realUploadBody = await realUploadRes.json();
    const photoId = realUploadBody.photos[0].id as string;

    const photoGetRes = await photoGET(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`, {
        headers: { Cookie: tenantB.cookieHeader },
      }),
      photoParams(id, photoId),
    );
    expect(photoGetRes.status).toBe(404);

    const photoDeleteRes = await photoDELETE(
      new NextRequest(`http://localhost/api/items/${id}/photos/${photoId}`, {
        method: 'DELETE',
        headers: { Cookie: tenantB.cookieHeader },
      }),
      photoParams(id, photoId),
    );
    expect(photoDeleteRes.status).toBe(404);

    // Tenant A's photo row and item status must be entirely untouched by
    // every rejected cross-tenant attempt above.
    const photoRow = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(photoRow).toBeTruthy();
    const itemRow = db.prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string };
    expect(itemRow.status).toBe('Unlisted');
  });

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
