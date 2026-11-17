import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { GET } from '@/app/api/items/route';
import db from '@/lib/db';
import {
  getRequest,
  insertBookItem,
  insertClothingItem,
  insertElectronicsItem,
  currentTenant,
  resetItemsAndTenant,
} from '../fixtures/itemsApi';

// ---------------------------------------------------------------------------
// GET /api/items
// ---------------------------------------------------------------------------

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('empty DB → items: [], total: 0', async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('default listing returns items with nested details/platforms shape', async () => {
    insertBookItem({ title: 'Book A' });
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.title).toBe('Book A');
    expect(item.category).toBe('book');
    expect(item.platforms).toEqual([]);
    expect(item.details).toMatchObject({ author: 'Seed Author', publisher: 'Seed Publisher' });
  });

  it('filters by category=book', async () => {
    insertBookItem({ title: 'Book A' });
    insertClothingItem({ title: 'Clothing A' });

    const res = await GET(getRequest('?category=book'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].category).toBe('book');
  });

  it('filters by category=clothing', async () => {
    insertBookItem({ title: 'Book A' });
    insertClothingItem({ title: 'Clothing A' });

    const res = await GET(getRequest('?category=clothing'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].category).toBe('clothing');
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('invalid category param → 400', async () => {
    const res = await GET(getRequest('?category=shoes'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid category.');
  });

  it('filters by status', async () => {
    insertBookItem({ title: 'Unlisted Book', status: 'Unlisted' });
    insertBookItem({
      title: 'Listed Book',
      status: 'Listed',
      listing_price: 1500,
    });

    const res = await GET(getRequest('?status=Listed'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('Listed Book');
  });

  it('filters by condition scoped to category (valid combination)', async () => {
    insertBookItem({ title: 'Good Book', condition: 'Good' });
    insertBookItem({ title: 'Poor Book', condition: 'Poor' });

    const res = await GET(getRequest('?category=book&condition=Good'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('Good Book');
  });

  it('condition outside the vocabulary for the given category → 422', async () => {
    const res = await GET(getRequest('?category=book&condition=EUC'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toEqual(['condition']);
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('condition without category filters across both categories via COALESCE', async () => {
    insertBookItem({ title: 'Good Book', condition: 'Good' });
    insertClothingItem({ title: 'EUC Jacket', condition: 'EUC' });

    const res = await GET(getRequest('?condition=Good'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('Good Book');
  });

  it('free-text search q matches title (case-insensitive-ish LIKE)', async () => {
    insertBookItem({ title: 'The Great Gatsby' });
    insertBookItem({ title: 'Moby Dick' });

    const res = await GET(getRequest('?q=Great'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('The Great Gatsby');
  });

  it('free-text search q matches author for book category', async () => {
    insertBookItem({ title: 'Some Novel', author: 'Jane Austen' });
    insertBookItem({ title: 'Other Novel', author: 'Mark Twain' });

    const res = await GET(getRequest('?q=Austen'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('Some Novel');
  });

  it('free-text search q matches clothing brand', async () => {
    insertClothingItem({ title: 'Random Jacket', brand: 'UniqueBrandXYZ' });

    const res = await GET(getRequest('?q=UniqueBrandXYZ'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].details.brand).toBe('UniqueBrandXYZ');
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('free-text search q matches clothing color, material, gender_department, size_label', async () => {
    insertClothingItem({ title: 'Item A', color: 'Chartreuse' });
    insertClothingItem({ title: 'Item B', material: 'Merino Wool' });
    insertClothingItem({ title: 'Item C', gender_department: 'Unisex Kids' });
    insertClothingItem({ title: 'Item D', size_label: 'XXL-Tall' });

    expect((await (await GET(getRequest('?q=Chartreuse'))).json()).total).toBe(1);
    expect((await (await GET(getRequest('?q=Merino'))).json()).total).toBe(1);
    expect((await (await GET(getRequest('?q=Unisex'))).json()).total).toBe(1);
    expect((await (await GET(getRequest('?q=XXL-Tall'))).json()).total).toBe(1);
  });

  it('free-text search q matches book publisher and isbn', async () => {
    insertBookItem({ title: 'Book A', publisher: 'UniquePublisherXYZ' });
    insertBookItem({ title: 'Book B', isbn: '9780306406157' });

    expect((await (await GET(getRequest('?q=UniquePublisherXYZ'))).json()).total).toBe(1);
    expect((await (await GET(getRequest('?q=9780306406157'))).json()).total).toBe(1);
  });

  it('free-text search expands synonyms — "coat" matches a title containing "jacket"', async () => {
    insertClothingItem({ title: 'Denim Jacket' });
    insertBookItem({ title: 'Unrelated Book' });

    const res = await GET(getRequest('?q=coat'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('Denim Jacket');
  });

  it('free-text search expands synonyms — "1st edition" matches a title containing "first edition"', async () => {
    insertBookItem({ title: 'Rare First Edition Copy' });

    const res = await GET(getRequest('?q=1st%20edition'));
    const body = await res.json();
    expect(body.total).toBe(1);
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('free-text search is multi-term: "great gatsby" matches a title containing both words', async () => {
    insertBookItem({ title: 'The Great Gatsby' });
    insertBookItem({ title: 'Moby Dick' });

    const res = await GET(getRequest('?q=great%20gatsby'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('The Great Gatsby');
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('free-text search escapes LIKE wildcards so a literal % or _ in the query does not match everything', async () => {
    insertBookItem({ title: 'Normal Book' });
    insertBookItem({ title: '50% Off Sale Copy' });

    const res = await GET(getRequest('?q=50%25'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('50% Off Sale Copy');
  });

  it('q exceeding 200 characters → 400', async () => {
    const res = await GET(getRequest(`?q=${'a'.repeat(201)}`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('q exceeds 200 characters.');
  });

  it('empty results case for a non-matching filter', async () => {
    insertBookItem({ title: 'Book A' });
    const res = await GET(getRequest('?q=NoSuchTitleAtAll'));
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('pagination: limit and page slice results, total reflects full count', async () => {
    for (let i = 0; i < 5; i++) {
      insertBookItem({ title: `Book ${i}` });
    }
    const res = await GET(getRequest('?limit=2&page=0'));
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(2);
    expect(body.limit).toBe(2);
    expect(body.page).toBe(0);

    const res2 = await GET(getRequest('?limit=2&page=2'));
    const body2 = await res2.json();
    expect(body2.items).toHaveLength(1); // 5 items, page 2 (offset 4) → 1 left
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('default page/limit envelope values when omitted', async () => {
    insertBookItem();
    const res = await GET(getRequest());
    const body = await res.json();
    expect(body.page).toBe(0);
    expect(body.limit).toBe(25);
  });

  it('negative page → 400', async () => {
    const res = await GET(getRequest('?page=-1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('page must be a non-negative integer.');
  });

  it('non-integer page → 400', async () => {
    const res = await GET(getRequest('?page=abc'));
    expect(res.status).toBe(400);
  });

  it('limit of 0 → 400', async () => {
    const res = await GET(getRequest('?limit=0'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('limit must be 1–200.');
  });

  it('limit above 200 → 400', async () => {
    const res = await GET(getRequest('?limit=201'));
    expect(res.status).toBe(400);
  });

  it('limit of exactly 1 is accepted (lower boundary)', async () => {
    const res = await GET(getRequest('?limit=1'));
    expect(res.status).toBe(200);
  });

  it('limit of exactly 200 is accepted', async () => {
    const res = await GET(getRequest('?limit=200'));
    expect(res.status).toBe(200);
  });

  it('q of exactly 200 characters is accepted (boundary)', async () => {
    const res = await GET(getRequest(`?q=${'a'.repeat(200)}`));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('internal server error is returned as 500 with a generic message when a DB read fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const res = await GET(getRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error.');
    expect(errorSpy).toHaveBeenCalledWith('GET /api/items error:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('clothing item details nest brand/size/color/measurements', async () => {
    insertClothingItem({ title: 'Nice Jacket', brand: 'Patagonia', color: 'Green', waist_in: 30 });
    const res = await GET(getRequest('?category=clothing'));
    const body = await res.json();
    expect(body.items[0].details).toMatchObject({
      brand: 'Patagonia',
      color: 'Green',
      waist_in: 30,
    });
  });

  it('electronics item details nest brand/model/processor/ram_gb', async () => {
    insertElectronicsItem({
      title: 'Nice Laptop', brand: 'Apple', model: 'MacBook Pro', processor: 'M2', ram_gb: 16,
    });
    const res = await GET(getRequest('?category=electronics'));
    const body = await res.json();
    expect(body.items[0].details).toMatchObject({
      brand: 'Apple',
      model: 'MacBook Pro',
      processor: 'M2',
      ram_gb: 16,
    });
  });
});

describe('GET /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('platforms are aggregated into a CSV-derived array', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at, tenant_id) VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(uuidv4(), id, 'eBay', currentTenant().tenantId);
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at, tenant_id) VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(uuidv4(), id, 'AbeBooks', currentTenant().tenantId);

    const res = await GET(getRequest());
    const body = await res.json();
    expect(body.items[0].platforms.sort()).toEqual(['AbeBooks', 'eBay']);
  });
});
