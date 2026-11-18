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


// One entry per route handler, so each test lists the calls it makes instead
// of repeating the request plumbing.
interface RouteCtx {
  id: string;
  photoId: string;
  cookie?: string;
  order?: string[];
}
type RouteCall = (ctx: RouteCtx) => Promise<Response>;

type RouteInit = { headers?: Record<string, string>; body?: BodyInit };

function routeRequest(path: string, method: string, ctx: RouteCtx, init: RouteInit = {}): NextRequest {
  const headers: Record<string, string> = { ...init.headers };
  if (ctx.cookie) headers.Cookie = ctx.cookie;
  return new NextRequest(`http://localhost/api/items/${ctx.id}/${path}`, { ...init, method, headers });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const callStatus: RouteCall = (ctx) =>
  statusPOST(
    routeRequest('status', 'POST', ctx, { headers: JSON_HEADERS, body: JSON.stringify({ status: 'Donated' }) }),
    params(ctx.id),
  );
const callPhotosPost: RouteCall = (ctx) =>
  photosPOST(routeRequest('photos', 'POST', ctx, { body: tinyPngFormData() }), params(ctx.id));
const callPhotosPatch: RouteCall = (ctx) =>
  photosPATCH(
    routeRequest('photos', 'PATCH', ctx, { headers: JSON_HEADERS, body: JSON.stringify({ order: ctx.order ?? [] }) }),
    params(ctx.id),
  );
const callPhotoGet: RouteCall = (ctx) =>
  photoGET(routeRequest(`photos/${ctx.photoId}`, 'GET', ctx), photoParams(ctx.id, ctx.photoId));
const callPhotoDelete: RouteCall = (ctx) =>
  photoDELETE(routeRequest(`photos/${ctx.photoId}`, 'DELETE', ctx), photoParams(ctx.id, ctx.photoId));
const callPhonePost: RouteCall = (ctx) =>
  phoneSessionPOST(routeRequest('phone-session', 'POST', ctx, { headers: { host: TAILNET_HOST } }), params(ctx.id));
const callPhoneGet: RouteCall = (ctx) =>
  phoneSessionGET(routeRequest('phone-session', 'GET', ctx), params(ctx.id));
const callPhoneDelete: RouteCall = (ctx) =>
  phoneSessionDELETE(routeRequest('phone-session', 'DELETE', ctx), params(ctx.id));

async function expectStatus(call: RouteCall, ctx: RouteCtx, status: number): Promise<Response> {
  const res = await call(ctx);
  expect(res.status).toBe(status);
  return res;
}

async function expectAllStatus(calls: RouteCall[], ctx: RouteCtx, status: number) {
  for (const call of calls) {
    await expectStatus(call, ctx, status);
  }
}

async function uploadPhoto(ctx: RouteCtx): Promise<string> {
  const res = await expectStatus(callPhotosPost, ctx, 201);
  const body = await res.json();
  return body.photos[0].id as string;
}

describe('tenant scoping: status, photos, photos/[photoId], phone-session › unauthenticated requests', () => {
  it('rejects unauthenticated requests to all four routes with 401', async () => {
    const tenant = createTestTenant();
    const ctx = { id: insertClothingItem(tenant.tenantId), photoId: uuidv4() };

    await expectAllStatus(
      [callStatus, callPhotosPost, callPhotosPatch, callPhotoGet, callPhotoDelete],
      ctx,
      401,
    );
    await expectAllStatus([callPhonePost, callPhoneGet, callPhoneDelete], ctx, 401);
  });
});

describe('tenant scoping: status, photos, photos/[photoId], phone-session › own items', () => {
  it("lets an authenticated tenant mutate their own item's status/photos/phone-session exactly as before", async () => {
    const tenant = createTestTenant();
    const ctx: RouteCtx = { id: insertClothingItem(tenant.tenantId), photoId: '', cookie: tenant.cookieHeader };

    await expectStatus(callStatus, ctx, 200);
    ctx.photoId = await uploadPhoto(ctx);
    await expectStatus(callPhotoGet, ctx, 200);
    await expectStatus(callPhotosPatch, { ...ctx, order: [ctx.photoId] }, 200);
    await expectStatus(callPhonePost, ctx, 201);
    await expectStatus(callPhoneGet, ctx, 200);
    await expectStatus(callPhoneDelete, ctx, 204);
    await expectStatus(callPhotoDelete, ctx, 200);
  });
});

describe('tenant scoping: status, photos, photos/[photoId], phone-session › cross-tenant requests', () => {
  it("returns 404 (not the resource) when a second tenant tries to mutate the first tenant's item via any of these routes", async () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const id = insertClothingItem(tenantA.tenantId);
    const probe = { id, photoId: uuidv4(), cookie: tenantB.cookieHeader };

    await expectAllStatus([callStatus, callPhotosPost, callPhotosPatch], probe, 404);
    await expectAllStatus([callPhonePost, callPhoneGet, callPhoneDelete], probe, 404);

    // Upload a real photo as the owning tenant so a real photoId exists to
    // probe GET/DELETE cross-tenant against.
    const photoId = await uploadPhoto({ id, photoId: '', cookie: tenantA.cookieHeader });

    await expectAllStatus([callPhotoGet, callPhotoDelete], { ...probe, photoId }, 404);

    // Tenant A's photo row and item status must be entirely untouched by
    // every rejected cross-tenant attempt above.
    const photoRow = db.prepare('SELECT id FROM item_photos WHERE id = ?').get(photoId);
    expect(photoRow).toBeTruthy();
    const itemRow = db.prepare('SELECT status FROM items WHERE id = ?').get(id) as { status: string };
    expect(itemRow.status).toBe('Unlisted');
  });
});

describe('tenant scoping: status, photos, photos/[photoId], phone-session › pairing token uploads', () => {
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
