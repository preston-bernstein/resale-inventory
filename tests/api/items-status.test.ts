import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { POST } from '@/app/api/items/[id]/status/route';
import { createTestTenant } from '../helpers/tenant';
import { createItemSeeder } from './itemSeed';

const BASE_URL = 'http://localhost/api/items';

// Task 17 retrofit (finished by Task 22): this route now requires a tenant
// session cookie. A fresh tenant is created per test (see beforeEach below)
// and stashed here so the request builder and item-insert helper below can
// pick it up without every call site needing to be touched individually.
let currentTenant: ReturnType<typeof createTestTenant>;

const { insertBookItem } = createItemSeeder(() => currentTenant.tenantId);

function statusUrl(id: string) {
  return `${BASE_URL}/${id}/status`;
}

function makeRequest(id: string, payload: unknown, cookie = currentTenant?.cookieHeader) {
  return new NextRequest(statusUrl(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function getItemRow(id: string) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

function setupPOSTApiItemsId() {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
    currentTenant = createTestTenant();
  });
}

describe('POST /api/items/[id]/status › allowed transitions (1 of 2)', () => {
  setupPOSTApiItemsId();

  // -------------------------------------------------------------------
  // Valid transitions
  // -------------------------------------------------------------------

  it('Unlisted -> Listed succeeds (200) when listing_price is already set', async () => {
    const id = insertBookItem({ listing_price: 1200 });
    const res = await POST(makeRequest(id, { status: 'Listed' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Listed');
    expect(getItemRow(id)?.status).toBe('Listed');
  });

  it('Listed -> Sale Pending succeeds (200)', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1200 });
    const res = await POST(makeRequest(id, { status: 'Sale Pending' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Sale Pending');
  });
});

describe('POST /api/items/[id]/status › allowed transitions (2 of 2)', () => {
  setupPOSTApiItemsId();

  it('Sale Pending -> Sold succeeds (200) with sale_price/sale_platform/sale_date, and sets gross_profit', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1500, acquisition_cost: 500 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1500, sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Sold');
    expect(body.sale_price).toBe(1500);
    expect(body.sale_platform).toBe('eBay');
    expect(body.sale_date).toBe('2024-06-01');
    expect(body.gross_profit).toBe(1000); // 1500 - 500

    const row = getItemRow(id) as { sale_price: number; sale_platform: string; sale_date: string };
    expect(row.sale_price).toBe(1500);
    expect(row.sale_platform).toBe('eBay');
    expect(row.sale_date).toBe('2024-06-01');
  });

  it('trims whitespace on sale_platform before persisting', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_platform: '  Poshmark  ', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const row = getItemRow(id) as { sale_platform: string };
    expect(row.sale_platform).toBe('Poshmark');
  });
});

describe('POST /api/items/[id]/status › donate and discard', () => {
  setupPOSTApiItemsId();

  it('Unlisted -> Donated succeeds (200)', async () => {
    const id = insertBookItem();
    const res = await POST(makeRequest(id, { status: 'Donated' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Donated');
  });

  it('Unlisted -> Discarded succeeds (200)', async () => {
    const id = insertBookItem();
    const res = await POST(makeRequest(id, { status: 'Discarded' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('Discarded');
  });

  it('response includes platforms array derived from item_platforms', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1000 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at, tenant_id) VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(uuidv4(), id, 'eBay', currentTenant.tenantId);
    const res = await POST(makeRequest(id, { status: 'Sale Pending' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platforms).toEqual(['eBay']);
    expect(body.platforms_csv).toBeUndefined();
  });
});

describe('POST /api/items/[id]/status › rejected transitions', () => {
  setupPOSTApiItemsId();

  // -------------------------------------------------------------------
  // Invalid / terminal transitions
  // -------------------------------------------------------------------

  it('Sold -> Listed is rejected (terminal), 422, and item remains Sold', async () => {
    const id = insertBookItem({
      status: 'Sold', listing_price: 1000, sale_price: 1000, sale_platform: 'eBay', sale_date: '2024-06-01',
    });
    const res = await POST(makeRequest(id, { status: 'Listed' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Sold.*Listed.*not permitted/);
    expect(getItemRow(id)?.status).toBe('Sold');
  });

  it('Listed -> Sold directly is rejected (must go via Sale Pending), 422', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/not permitted/);
    expect(getItemRow(id)?.status).toBe('Listed');
  });

  it('Unlisted -> Sale Pending is rejected, 422', async () => {
    const id = insertBookItem();
    const res = await POST(makeRequest(id, { status: 'Sale Pending' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
  });

  it('Donated is terminal: Donated -> Listed rejected, 422', async () => {
    const id = insertBookItem({ status: 'Donated' });
    const res = await POST(makeRequest(id, { status: 'Listed', }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/items/[id]/status › invalid bodies', () => {
  setupPOSTApiItemsId();

  it('invalid status string is rejected, 422', async () => {
    const id = insertBookItem();
    const res = await POST(makeRequest(id, { status: 'NotARealStatus' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid status value/);
  });

  it('missing status field is rejected, 422', async () => {
    const id = insertBookItem();
    const res = await POST(makeRequest(id, {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
  });

  it('malformed JSON body is rejected, 400', async () => {
    const id = insertBookItem();
    const req = new NextRequest(statusUrl(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: currentTenant.cookieHeader },
      body: '{not valid json',
    });
    const res = await POST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid JSON body/);
  });
});

describe('POST /api/items/[id]/status › sold required fields', () => {
  setupPOSTApiItemsId();

  // -------------------------------------------------------------------
  // Sold transition — required field validation
  // -------------------------------------------------------------------

  it('Sold transition missing sale_price is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/sale_price, sale_platform, and sale_date are required/);
  });

  it('Sold transition missing sale_platform is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });

  it('Sold transition missing sale_date is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_platform: 'eBay' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });

  it('Sold transition with blank sale_platform (whitespace only) is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_platform: '   ', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });
});

describe('POST /api/items/[id]/status › sold price and date limits', () => {
  setupPOSTApiItemsId();

  it('Sold transition with non-integer sale_price is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 19.99, sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });

  it('Sold transition with negative sale_price is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: -5, sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });

  it('Sold transition with sale_price over the 100,000,000 cap is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 100_000_001, sale_platform: 'eBay', sale_date: '2024-06-01' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });

  it('Sold transition with malformed sale_date is rejected, 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await POST(
      makeRequest(id, { status: 'Sold', sale_price: 1000, sale_platform: 'eBay', sale_date: '06/01/2024' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(422);
  });
});

describe('POST /api/items/[id]/status › listing price and unknown item', () => {
  setupPOSTApiItemsId();

  // -------------------------------------------------------------------
  // Missing listing_price guard on Listed / Sale Pending
  // -------------------------------------------------------------------

  it('Unlisted -> Listed without a listing_price set is rejected, 422 with actionable error', async () => {
    const id = insertBookItem({ listing_price: null });
    const res = await POST(makeRequest(id, { status: 'Listed' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot list an item without a listing_price/);
    expect(getItemRow(id)?.status).toBe('Unlisted');
  });

  // -------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------

  it('transitioning a non-existent item id returns 404', async () => {
    const id = uuidv4();
    const res = await POST(makeRequest(id, { status: 'Listed' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Not found/);
  });
});
