import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { GET } from '@/app/api/items/suggestions/route';
import { createTestTenant } from '../fixtures/tenant';
import { seedBookItem, seedClothingItem } from '../fixtures/items';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Task 21 retrofit (finished by Task 22): this route now requires a tenant
// session cookie. A fresh tenant is created per test (see beforeEach below)
// and stashed here so req() below and the insert helpers can pick it up
// without every call site needing to be touched individually.
let currentTenant: ReturnType<typeof createTestTenant>;

function insertBookItem(overrides: Record<string, unknown> = {}): string {
  return seedBookItem(currentTenant.tenantId, { title: 'Test Book', author: 'Test Author', publisher: 'Test Publisher', ...overrides });
}

function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  return seedClothingItem(currentTenant.tenantId, { title: 'Test Clothing Item', brand: 'TestBrand', ...overrides });
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

function req(query: string) {
  return new NextRequest(`http://localhost/api/items/suggestions${query}`, {
    headers: { Cookie: currentTenant.cookieHeader },
  });
}

const setupGETApiItemsSuggestions = () => {
  cleanTables();
  currentTenant = createTestTenant();
};

describe('GET /api/items/suggestions', () => {
  beforeEach(setupGETApiItemsSuggestions);

  it('returns 400 for a missing field param', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Unknown or missing field/);
  });

  it('returns 400 for an unrecognized field value', async () => {
    const res = await GET(req('?field=nonsense'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Unknown or missing field/);
  });

  it('field=brand: returns distinct brands, most-frequent first, alpha tiebreak', async () => {
    insertClothingItem({ brand: 'Patagonia' });
    insertClothingItem({ brand: 'Patagonia' });
    insertClothingItem({ brand: 'Levi\'s' });
    insertClothingItem({ brand: 'Levi\'s' });
    insertClothingItem({ brand: 'Carhartt' });

    const res = await GET(req('?field=brand'));
    expect(res.status).toBe(200);
    const data = await res.json();
    // Patagonia and Levi's tie at count 2, so alpha tiebreak: Levi's < Patagonia
    expect(data.values).toEqual(["Levi's", 'Patagonia', 'Carhartt']);
  });

  it('field=brand: excludes null/empty brand values', async () => {
    // brand is NOT NULL in schema, so simulate "no value entered" edge case
    // with an empty string, which the query explicitly excludes.
    insertClothingItem({ brand: '' });
    insertClothingItem({ brand: 'RealBrand' });

    const res = await GET(req('?field=brand'));
    const data = await res.json();
    expect(data.values).toEqual(['RealBrand']);
  });
});

describe('GET /api/items/suggestions', () => {
  beforeEach(setupGETApiItemsSuggestions);

  it('field=color: returns distinct clothing colors', async () => {
    insertClothingItem({ color: 'Red' });
    insertClothingItem({ color: 'Blue' });
    insertClothingItem({ color: null });

    const res = await GET(req('?field=color'));
    const data = await res.json();
    expect(data.values.sort()).toEqual(['Blue', 'Red']);
  });

  it('field=material: returns distinct clothing materials', async () => {
    insertClothingItem({ material: 'Cotton' });
    insertClothingItem({ material: 'Wool' });

    const res = await GET(req('?field=material'));
    const data = await res.json();
    expect(data.values.sort()).toEqual(['Cotton', 'Wool']);
  });

  it('field=gender_department: returns distinct values', async () => {
    insertClothingItem({ gender_department: 'Mens' });
    insertClothingItem({ gender_department: 'Womens' });
    insertClothingItem({ gender_department: 'Mens' });

    const res = await GET(req('?field=gender_department'));
    const data = await res.json();
    expect(data.values[0]).toBe('Mens'); // most frequent
    expect(data.values).toContain('Womens');
  });

  it('field=author: returns distinct book authors', async () => {
    insertBookItem({ author: 'Frank Herbert' });
    insertBookItem({ author: 'Andy Weir' });
    insertBookItem({ author: 'Frank Herbert' });

    const res = await GET(req('?field=author'));
    const data = await res.json();
    expect(data.values[0]).toBe('Frank Herbert');
    expect(data.values).toContain('Andy Weir');
  });
});

describe('GET /api/items/suggestions', () => {
  beforeEach(setupGETApiItemsSuggestions);

  it('field=publisher: returns distinct book publishers', async () => {
    insertBookItem({ publisher: 'Chilton' });
    insertBookItem({ publisher: 'Ballantine' });

    const res = await GET(req('?field=publisher'));
    const data = await res.json();
    expect(data.values.sort()).toEqual(['Ballantine', 'Chilton']);
  });

  it('field=size_label without brand returns empty values (no scope)', async () => {
    insertClothingItem({ brand: 'Patagonia', size_label: 'L' });
    const res = await GET(req('?field=size_label'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.values).toEqual([]);
  });

  it('field=size_label with blank brand returns empty values', async () => {
    const res = await GET(req('?field=size_label&brand=%20'));
    const data = await res.json();
    expect(data.values).toEqual([]);
  });

  it('field=size_label with brand scopes suggestions to that brand only', async () => {
    insertClothingItem({ brand: 'Patagonia', size_label: 'L' });
    insertClothingItem({ brand: 'Patagonia', size_label: 'M' });
    insertClothingItem({ brand: 'Patagonia', size_label: 'L' });
    insertClothingItem({ brand: 'Levi\'s', size_label: '32x30' });

    const res = await GET(req('?field=size_label&brand=Patagonia'));
    const data = await res.json();
    expect(data.values).toEqual(['L', 'M']); // L has count 2, most frequent first
  });

  it('field=size_label with a brand that has no items returns empty values', async () => {
    insertClothingItem({ brand: 'Patagonia', size_label: 'L' });
    const res = await GET(req('?field=size_label&brand=NoSuchBrand'));
    const data = await res.json();
    expect(data.values).toEqual([]);
  });

  it('returns an empty values array when there is no history for the field', async () => {
    const res = await GET(req('?field=brand'));
    const data = await res.json();
    expect(data.values).toEqual([]);
  });
});
