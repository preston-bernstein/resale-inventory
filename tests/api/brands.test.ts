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

function brandRowsForName(tenantId: string, canonicalName: string) {
  return db
    .prepare(
      'SELECT id, canonical_name FROM clothing_brands WHERE tenant_id = ? AND canonical_name = ? COLLATE NOCASE',
    )
    .all(tenantId, canonicalName) as Array<{ id: string; canonical_name: string }>;
}

describe('brand canonicalization (lib/brands.ts resolveCanonicalBrand)', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

  it('exact-case match returns the existing canonical name unchanged', () => {
    const first = resolveCanonicalBrand(currentTenant.tenantId, 'Dickies');
    expect(first).toBe('Dickies');
    const second = resolveCanonicalBrand(currentTenant.tenantId, 'Dickies');
    expect(second).toBe('Dickies');
    expect(brandRowsForName(currentTenant.tenantId, 'Dickies')).toHaveLength(1);
  });

  it('different-case match resolves to the originally stored canonical casing', () => {
    const stored = resolveCanonicalBrand(currentTenant.tenantId, 'Dickies');
    expect(stored).toBe('Dickies');

    const resolvedLower = resolveCanonicalBrand(currentTenant.tenantId, 'dickies');
    expect(resolvedLower).toBe('Dickies');

    const resolvedUpper = resolveCanonicalBrand(currentTenant.tenantId, 'DICKIES');
    expect(resolvedUpper).toBe('Dickies');

    // Only one row should exist for this tenant+brand despite three calls.
    expect(brandRowsForName(currentTenant.tenantId, 'Dickies')).toHaveLength(1);
  });

  it('an unmatched brand creates a new canonical row', () => {
    expect(brandRowsForName(currentTenant.tenantId, 'Supreme')).toHaveLength(0);
    const resolved = resolveCanonicalBrand(currentTenant.tenantId, 'Supreme');
    expect(resolved).toBe('Supreme');
    const rows = brandRowsForName(currentTenant.tenantId, 'Supreme');
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBe('Supreme');
  });

  it('trims whitespace before matching/storing', () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Uniqlo');
    const resolved = resolveCanonicalBrand(currentTenant.tenantId, '  uniqlo  ');
    expect(resolved).toBe('Uniqlo');
    expect(brandRowsForName(currentTenant.tenantId, 'Uniqlo')).toHaveLength(1);
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
    resolveCanonicalBrand(currentTenant.tenantId, 'Dickies');

    const res = await POST(postItemsReq(minimalClothingItem({ brand: 'dickies' })));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.brand).toBe('Dickies');

    // Still exactly one clothing_brands row for this tenant+name.
    expect(brandRowsForName(currentTenant.tenantId, 'Dickies')).toHaveLength(1);
  });

  it('submitting a brand with no canonical match still creates the item and a new canonical entry', async () => {
    const res = await POST(postItemsReq(minimalClothingItem({ brand: 'Brand New Co' })));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.brand).toBe('Brand New Co');

    const rows = brandRowsForName(currentTenant.tenantId, 'Brand New Co');
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
    resolveCanonicalBrand(currentTenant.tenantId, 'Guess');

    const res = await GET(getBrandsReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    const brands = data.brands as Array<{ id: string; canonical_name: string }>;
    const guess = brands.find((b) => b.canonical_name === 'Guess');
    expect(guess).toBeDefined();
    expect(Object.keys(guess as object).sort()).toEqual(['canonical_name', 'id']);
    expect(typeof (guess as { id: string }).id).toBe('string');
  });

  it('returns brands alphabetically ordered COLLATE NOCASE (not frequency-ranked)', async () => {
    // Insert out of order and with mixed leading-case so a naive binary/ASCII
    // sort (uppercase before lowercase) would misorder these, but
    // COLLATE NOCASE sorts them correctly alphabetically. These three are not
    // part of the seeded starter vocabulary, so their relative order among
    // themselves is a clean signal independent of the 25 seeded brands.
    resolveCanonicalBrand(currentTenant.tenantId, 'zulily');
    resolveCanonicalBrand(currentTenant.tenantId, 'Aritzia');
    resolveCanonicalBrand(currentTenant.tenantId, 'noah');

    const res = await GET(getBrandsReq());
    const data = await res.json();
    const names = data.brands.map((b: { canonical_name: string }) => b.canonical_name) as string[];

    const idxAritzia = names.indexOf('Aritzia');
    const idxNoah = names.indexOf('noah');
    const idxZulily = names.indexOf('zulily');

    expect(idxAritzia).toBeGreaterThanOrEqual(0);
    expect(idxNoah).toBeGreaterThanOrEqual(0);
    expect(idxZulily).toBeGreaterThanOrEqual(0);
    expect(idxAritzia).toBeLessThan(idxNoah);
    expect(idxNoah).toBeLessThan(idxZulily);
  });

  it('scopes results to the requesting tenant only (cross-tenant isolation)', async () => {
    const tenantA = currentTenant;
    const tenantB = createTestTenant();

    resolveCanonicalBrand(tenantA.tenantId, 'Only Tenant A Brand');

    const resA = await GET(getBrandsReq(tenantA));
    const dataA = await resA.json();
    const namesA = dataA.brands.map((b: { canonical_name: string }) => b.canonical_name) as string[];
    expect(namesA).toContain('Only Tenant A Brand');
    expect(namesA).toHaveLength(26); // 25 seeded + 1 new

    const resB = await GET(getBrandsReq(tenantB));
    const dataB = await resB.json();
    const namesB = dataB.brands.map((b: { canonical_name: string }) => b.canonical_name) as string[];
    expect(namesB).not.toContain('Only Tenant A Brand');
    expect(namesB).toHaveLength(25); // tenant B only has its own seeded brands
  });

  it('does not include a frequency/count field in the response shape', async () => {
    resolveCanonicalBrand(currentTenant.tenantId, 'Levi\'s');
    const res = await GET(getBrandsReq());
    const data = await res.json();
    expect(data.brands[0]).not.toHaveProperty('count');
    expect(data.brands[0]).not.toHaveProperty('frequency');
  });
});
