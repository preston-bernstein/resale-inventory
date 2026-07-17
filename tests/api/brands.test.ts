import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { resolveCanonicalBrand } from '@/lib/brands';
import { GET } from '@/app/api/brands/route';
import { POST } from '@/app/api/items/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items; ' +
    'DELETE FROM clothing_brands;',
  );
}

function getBrandsReq(tenant: ReturnType<typeof createTestTenant> = currentTenant) {
  return new NextRequest('http://localhost/api/brands', {
    headers: { Cookie: tenant.cookieHeader },
  });
}

function postItemsReq(body: unknown, tenant: ReturnType<typeof createTestTenant> = currentTenant): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: { Cookie: tenant.cookieHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function minimalClothingItem(overrides: Record<string, unknown> = {}) {
  return {
    category: 'clothing',
    title: 'Test Item',
    brand: 'Some Brand',
    size_label: 'M',
    condition: 'EUC',
    acquisition_cost: 1000,
    acquisition_date: '2026-01-01',
    ...overrides,
  };
}

function brandRowsForTenant(tenantId: string) {
  return db
    .prepare('SELECT id, canonical_name FROM clothing_brands WHERE tenant_id = ?')
    .all(tenantId) as Array<{ id: string; canonical_name: string }>;
}

describe('brand canonicalization (lib/brands.ts resolveCanonicalBrand)', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('exact-case match returns the existing canonical name unchanged', () => {
    const first = resolveCanonicalBrand(currentTenant.tenantId, 'Nike');
    expect(first).toBe('Nike');
    const second = resolveCanonicalBrand(currentTenant.tenantId, 'Nike');
    expect(second).toBe('Nike');
    expect(brandRowsForTenant(currentTenant.tenantId)).toHaveLength(1);
  });

  it('different-case match resolves to the originally stored canonical casing', () => {
    const stored = resolveCanonicalBrand(currentTenant.tenantId, 'Nike');
    expect(stored).toBe('Nike');

    const resolvedLower = resolveCanonicalBrand(currentTenant.tenantId, 'nike');
    expect(resolvedLower).toBe('Nike');

    const resolvedUpper = resolveCanonicalBrand(currentTenant.tenantId, 'NIKE');
    expect(resolvedUpper).toBe('Nike');

    // Only one row should exist for this tenant+brand despite three calls.
    expect(brandRowsForTenant(currentTenant.tenantId)).toHaveLength(1);
  });

  it('an unmatched brand creates a new canonical row', () => {
    expect(brandRowsForTenant(currentTenant.tenantId)).toHaveLength(0);
    const resolved = resolveCanonicalBrand(currentTenant.tenantId, 'Patagonia');
    expect(resolved).toBe('Patagonia');
    const rows = brandRowsForTenant(currentTenant.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBe('Patagonia');
  });

  it('trims whitespace before matching/storing', () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Carhartt');
    const resolved = resolveCanonicalBrand(currentTenant.tenantId, '  carhartt  ');
    expect(resolved).toBe('Carhartt');
    expect(brandRowsForTenant(currentTenant.tenantId)).toHaveLength(1);
  });

  it('concurrent resolution of the same new brand name races safely to one row', async () => {
    const results = await Promise.all([
      Promise.resolve().then(() => resolveCanonicalBrand(currentTenant.tenantId, 'Wrangler')),
      Promise.resolve().then(() => resolveCanonicalBrand(currentTenant.tenantId, 'Wrangler')),
      Promise.resolve().then(() => resolveCanonicalBrand(currentTenant.tenantId, 'wrangler')),
      Promise.resolve().then(() => resolveCanonicalBrand(currentTenant.tenantId, 'WRANGLER')),
    ]);

    // All calls must resolve to the same canonical string.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('Wrangler');

    // Only one row should have been inserted for this tenant+name despite
    // four concurrent callers all missing the cache at roughly the same time.
    const rows = db
      .prepare(
        'SELECT id, canonical_name FROM clothing_brands WHERE tenant_id = ? AND canonical_name = ? COLLATE NOCASE',
      )
      .all(currentTenant.tenantId, 'Wrangler') as Array<{ id: string; canonical_name: string }>;
    expect(rows).toHaveLength(1);
  });
});

describe('brand resolution end-to-end via POST /api/items', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('submitting a brand matching an existing canonical name (different case) persists the canonical casing', async () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Nike');

    const res = await POST(postItemsReq(minimalClothingItem({ brand: 'nike' })));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.brand).toBe('Nike');

    // Still exactly one clothing_brands row for this tenant.
    expect(brandRowsForTenant(currentTenant.tenantId)).toHaveLength(1);
  });

  it('submitting a brand with no canonical match still creates the item and a new canonical entry', async () => {
    const res = await POST(postItemsReq(minimalClothingItem({ brand: 'Brand New Co' })));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.brand).toBe('Brand New Co');

    const rows = brandRowsForTenant(currentTenant.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBe('Brand New Co');
  });
});

describe('GET /api/brands', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('returns { brands: [...] } shape with id + canonical_name only', async () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Patagonia');

    const res = await GET(getBrandsReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.brands).toHaveLength(1);
    expect(Object.keys(data.brands[0]).sort()).toEqual(['canonical_name', 'id']);
    expect(data.brands[0].canonical_name).toBe('Patagonia');
    expect(typeof data.brands[0].id).toBe('string');
  });

  it('returns brands alphabetically ordered COLLATE NOCASE (not frequency-ranked)', async () => {
    // Insert out of order and with mixed leading-case so a naive binary/ASCII
    // sort (uppercase before lowercase) would misorder these, but
    // COLLATE NOCASE sorts them correctly alphabetically.
    resolveCanonicalBrand(currentTenant.tenantId, 'zara');
    resolveCanonicalBrand(currentTenant.tenantId, 'Adidas');
    resolveCanonicalBrand(currentTenant.tenantId, 'nike');

    const res = await GET(getBrandsReq());
    const data = await res.json();
    expect(data.brands.map((b: { canonical_name: string }) => b.canonical_name)).toEqual([
      'Adidas',
      'nike',
      'zara',
    ]);
  });

  it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
    const tenantA = currentTenant;
    const tenantB = createTestTenant();

    resolveCanonicalBrand(tenantA.tenantId, 'Only Tenant A Brand');

    const resA = await GET(getBrandsReq(tenantA));
    const dataA = await resA.json();
    expect(dataA.brands.map((b: { canonical_name: string }) => b.canonical_name)).toEqual([
      'Only Tenant A Brand',
    ]);

    const resB = await GET(getBrandsReq(tenantB));
    const dataB = await resB.json();
    expect(dataB.brands).toEqual([]);
  });

  it('does not include a frequency/count field in the response shape', async () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Levi\'s');
    const res = await GET(getBrandsReq());
    const data = await res.json();
    expect(data.brands[0]).not.toHaveProperty('count');
    expect(data.brands[0]).not.toHaveProperty('frequency');
  });
});
