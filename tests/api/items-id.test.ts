import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { GET, PATCH } from '@/app/api/items/[id]/route';
import db from '@/lib/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getReq(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/${id}`);
}

/** Seed a book item directly via SQL (items + book_details). Returns the id. */
function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Seed Author',
    publisher: 'Seed Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition)
    VALUES (@id, @isbn, @author, @publisher, @condition)
  `).run(item);
  return id;
}

/** Seed a clothing item directly via SQL (items + clothing_details). Returns the id. */
function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'SeedBrand',
    size_label: 'M',
    color: null,
    material: null,
    gender_department: null,
    weight_oz: null,
    pit_to_pit_in: null,
    length_in: null,
    sleeve_length_in: null,
    waist_in: null,
    rise_in: null,
    inseam_in: null,
    leg_opening_in: null,
    hip_in: null,
    condition: 'EUC',
  };
  const item = { ...defaults, ...overrides, id, category: 'clothing' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO clothing_details
      (item_id, brand, size_label, color, material, gender_department, weight_oz,
       pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
       leg_opening_in, hip_in, condition)
    VALUES
      (@id, @brand, @size_label, @color, @material, @gender_department, @weight_oz,
       @pit_to_pit_in, @length_in, @sleeve_length_in, @waist_in, @rise_in, @inseam_in,
       @leg_opening_in, @hip_in, @condition)
  `).run(item);
  return id;
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

/**
 * Spies on db.prepare so the first `UPDATE items SET ...` statement issued
 * inside PATCH's transaction throws instead of running — this is the only
 * way to reach the PATCH catch block's SQLITE_CONSTRAINT_CHECK /
 * SQLITE_CONSTRAINT_UNIQUE / generic-error branches, none of which are
 * reachable through normal validation (the CHECK/UNIQUE constraints those
 * branches handle live in the DB schema, not in the route's own JS
 * validation). All other statements pass through to the real db.prepare.
 */
function mockDbErrorOnUpdate(code?: string) {
  const realPrepare = db.prepare.bind(db);
  return vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.startsWith('UPDATE items SET')) {
      const err = new Error('simulated failure') as Error & { code?: string };
      if (code) err.code = code;
      throw err;
    }
    return realPrepare(sql);
  });
}

// ---------------------------------------------------------------------------
// GET /api/items/[id]
// ---------------------------------------------------------------------------

describe('GET /api/items/[id]', () => {
  beforeEach(cleanTables);

  it('existing book item → 200, full shape with details/platforms/price_history/photos', async () => {
    const id = insertBookItem({ title: 'The Hobbit', author: 'J.R.R. Tolkien' });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');
    db.prepare(
      `INSERT INTO price_history (id, item_id, previous_price, new_price, changed_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, null, 1500);

    const res = await GET(getReq(id), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe(id);
    expect(body.category).toBe('book');
    expect(body.title).toBe('The Hobbit');
    expect(body.details).toMatchObject({ author: 'J.R.R. Tolkien', condition: 'Good' });
    expect(body.platforms).toEqual(['eBay']);
    expect(body.price_history).toHaveLength(1);
    expect(body.price_history[0]).toMatchObject({ previous_price: null, new_price: 1500 });
    expect(body.photos).toEqual([]); // FR14: books never get photo rows
  });

  it('existing clothing item → 200, full shape with clothing details and photos', async () => {
    const id = insertClothingItem({ title: 'Nice Jacket', brand: 'Patagonia', color: 'Green' });
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(uuidv4(), id, 'photo-1.jpg', 1);

    const res = await GET(getReq(id), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.category).toBe('clothing');
    expect(body.details).toMatchObject({ brand: 'Patagonia', color: 'Green', condition: 'EUC' });
    expect(body.platforms).toEqual([]);
    expect(body.price_history).toEqual([]);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatchObject({ path: 'photo-1.jpg', sort_order: 1 });
  });

  it('non-existent id → 404 "Not found."', async () => {
    const res = await GET(getReq('does-not-exist'), params('does-not-exist'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
  });

  it('internal server error is returned as 500 with a generic message when a DB read fails', async () => {
    const id = insertBookItem();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const res = await GET(getReq(id), params(id));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error.');
    expect(errorSpy).toHaveBeenCalledWith('GET /api/items/[id] error:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/items/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/items/[id]', () => {
  beforeEach(cleanTables);

  it('non-existent id → 404 "Not found."', async () => {
    const res = await PATCH(patchRequest('does-not-exist', { listing_price: 100 }), params('does-not-exist'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found.');
  });

  it('invalid JSON body → 400', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, '{bad json'), params(id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body.');
  });

  it('empty body (no recognized fields) → 422 "No fields to update."', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, {}), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('No fields to update.');
  });

  it('updating listing_price on an Unlisted item → 200, price_history row created', async () => {
    const id = insertBookItem(); // listing_price starts null

    const res = await PATCH(patchRequest(id, { listing_price: 1500 }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing_price).toBe(1500);

    const history = db.prepare('SELECT * FROM price_history WHERE item_id = ?').all(id) as Array<{
      previous_price: number | null;
      new_price: number;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0].previous_price).toBeNull();
    expect(history[0].new_price).toBe(1500);
  });

  it('setting listing_price to the same value does not create a new price_history row', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1500 });

    const res = await PATCH(patchRequest(id, { listing_price: 1500 }), params(id));
    expect(res.status).toBe(200);

    const history = db.prepare('SELECT * FROM price_history WHERE item_id = ?').all(id);
    expect(history).toHaveLength(0);
  });

  it('two sequential price updates → price_history accumulates both entries in order', async () => {
    const id = insertBookItem();

    await PATCH(patchRequest(id, { listing_price: 1000 }), params(id));
    await PATCH(patchRequest(id, { listing_price: 2000 }), params(id));

    const history = db
      .prepare('SELECT previous_price, new_price FROM price_history WHERE item_id = ? ORDER BY changed_at')
      .all(id) as Array<{ previous_price: number | null; new_price: number }>;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ previous_price: null, new_price: 1000 });
    expect(history[1]).toMatchObject({ previous_price: 1000, new_price: 2000 });
  });

  it('negative listing_price → 422 with fields includes listing_price', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { listing_price: -5 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('listing_price');
  });

  it('non-integer listing_price → 422 with fields includes listing_price', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { listing_price: 12.5 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('listing_price');
  });

  it('listing_price of exactly 0 is a valid boundary value (not rejected as negative)', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { listing_price: 0 }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing_price).toBe(0);
  });

  it('listing_price of 100,000,001 exceeds the upper boundary → 422', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { listing_price: 100_000_001 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('listing_price');
  });

  it('listing_price of exactly 100,000,000 is a valid upper-boundary value', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { listing_price: 100_000_000 }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing_price).toBe(100_000_000);
  });

  it('clearing listing_price (null) on an Unlisted item is allowed', async () => {
    const id = insertBookItem({ status: 'Unlisted', listing_price: null });
    const res = await PATCH(patchRequest(id, { listing_price: null }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing_price).toBeNull();
  });

  it('clearing listing_price (null) while status is Listed → 422 (must transition first)', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1500 });
    const res = await PATCH(patchRequest(id, { listing_price: null }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot clear listing_price/);
  });

  it('clearing listing_price (null) while status is Sale Pending → 422', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1500 });
    const res = await PATCH(patchRequest(id, { listing_price: null }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    // Asserting the specific message (not just the 422 status) matters here:
    // a DB-level CHECK constraint backstops the same rule, so a bug that
    // skipped the app-level PRICE_REQUIRED check would still surface as a
    // 422 — just the generic "Validation failed." from the CHECK-constraint
    // catch branch instead of this specific, actionable message.
    expect(body.error).toMatch(/Cannot clear listing_price/);
  });

  it('updating platforms replaces the full set', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');

    const res = await PATCH(patchRequest(id, { platforms: ['AbeBooks', 'Amazon'] }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platforms.sort()).toEqual(['AbeBooks', 'Amazon']);

    const rows = db.prepare('SELECT platform FROM item_platforms WHERE item_id = ?').all(id) as Array<{
      platform: string;
    }>;
    expect(rows.map((r) => r.platform).sort()).toEqual(['AbeBooks', 'Amazon']);
  });

  it('invalid platforms (not an array of strings) → 422 with fields includes platforms', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { platforms: ['eBay', 42] }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('platforms');
  });

  it('updating condition to a valid value for the item category', async () => {
    const id = insertBookItem({ condition: 'Good' });
    const res = await PATCH(patchRequest(id, { condition: 'Like New' }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.condition).toBe('Like New');
  });

  it('cross-category rejection: book item given a clothing-only condition value → 422', async () => {
    const id = insertBookItem({ condition: 'Good' });
    const res = await PATCH(patchRequest(id, { condition: 'EUC' }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toEqual(['condition']);

    // DB must remain unchanged
    const row = db.prepare('SELECT condition FROM book_details WHERE item_id = ?').get(id) as {
      condition: string;
    };
    expect(row.condition).toBe('Good');
  });

  it('cross-category rejection: clothing item given a book-only condition value → 422', async () => {
    const id = insertClothingItem({ condition: 'EUC' });
    const res = await PATCH(patchRequest(id, { condition: 'Good' }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toEqual(['condition']);

    const row = db.prepare('SELECT condition FROM clothing_details WHERE item_id = ?').get(id) as {
      condition: string;
    };
    expect(row.condition).toBe('EUC');
  });

  it('clothing-only field update (color, weight_oz, measurement) on a clothing item', async () => {
    const id = insertClothingItem();
    const res = await PATCH(
      patchRequest(id, { color: 'Red', weight_oz: 12, waist_in: 32 }),
      params(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.color).toBe('Red');
    expect(body.details.weight_oz).toBe(12);
    expect(body.details.waist_in).toBe(32);
  });

  it('clothing-only fields on a book item are silently ignored (not written) — body with only a clothing field → 422 "No fields to update."', async () => {
    const id = insertBookItem();
    const res = await PATCH(patchRequest(id, { color: 'Red' }), params(id));
    // category === 'book', so `color` never enters clothingUpdates; no
    // recognized field is present → "no fields to update", not a write.
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('No fields to update.');
  });

  it('invalid weight_oz on clothing item → 422 with fields includes weight_oz', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { weight_oz: -1 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('weight_oz');
  });

  it('invalid gender_department type on clothing item → 422', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { gender_department: 5 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('gender_department');
  });

  it('invalid measurement field on clothing item → 422', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { inseam_in: -2 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('inseam_in');
  });

  it('color of the wrong type (number) on a clothing item → 422 with fields includes color', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { color: 42 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('color');
  });

  it('color explicitly null on a clothing item is valid (clears it)', async () => {
    const id = insertClothingItem({ color: 'Red' });
    const res = await PATCH(patchRequest(id, { color: null }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.color).toBeNull();
  });

  it('material update on a clothing item is persisted', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { material: 'Cotton' }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.material).toBe('Cotton');
  });

  it('material of the wrong type (number) on a clothing item → 422 with fields includes material', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { material: 42 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('material');
  });

  it('gender_department update on a clothing item is persisted', async () => {
    const id = insertClothingItem();
    const res = await PATCH(patchRequest(id, { gender_department: 'Mens' }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.gender_department).toBe('Mens');
  });

  it('fields absent from the PATCH body are left untouched — gender_department, weight_oz, and a measurement field survive a color-only update', async () => {
    const id = insertClothingItem({ gender_department: 'Mens', weight_oz: 20, waist_in: 30 });
    const res = await PATCH(patchRequest(id, { color: 'Green' }), params(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.color).toBe('Green');
    expect(body.details.gender_department).toBe('Mens');
    expect(body.details.weight_oz).toBe(20);
    expect(body.details.waist_in).toBe(30);
  });

  it.each(['Sold', 'Removed', 'Donated', 'Discarded'])(
    'terminal status item (%s) blocks PATCH edits → 409',
    async (status) => {
      const id = insertBookItem({
        status,
        listing_price: 1000,
        sale_price: status === 'Sold' ? 1000 : null,
        sale_platform: status === 'Sold' ? 'eBay' : null,
        sale_date: status === 'Sold' ? '2024-06-01' : null,
      });

      const res = await PATCH(patchRequest(id, { listing_price: 2000 }), params(id));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Cannot update item with terminal status.');

      // DB must remain unchanged
      const row = db.prepare('SELECT listing_price FROM items WHERE id = ?').get(id) as {
        listing_price: number;
      };
      expect(row.listing_price).toBe(1000);
    },
  );

  it('non-terminal status item (Sale Pending) still allows PATCH edits', async () => {
    const id = insertBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const res = await PATCH(patchRequest(id, { listing_price: 1200 }), params(id));
    expect(res.status).toBe(200);
  });

  it('combined update: listing_price + condition + platforms in one request', async () => {
    const id = insertBookItem({ condition: 'Good', listing_price: null });
    const res = await PATCH(
      patchRequest(id, {
        listing_price: 2500,
        condition: 'Very Good',
        platforms: ['eBay'],
      }),
      params(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listing_price).toBe(2500);
    expect(body.details.condition).toBe('Very Good');
    expect(body.platforms).toEqual(['eBay']);
  });

  it('response envelope includes updated_at bump and details/platforms nested objects', async () => {
    const id = insertBookItem();
    const before = db.prepare('SELECT updated_at FROM items WHERE id = ?').get(id) as {
      updated_at: string;
    };
    const res = await PATCH(patchRequest(id, { condition: 'Very Good' }), params(id));
    const body = await res.json();
    expect(body).toHaveProperty('details');
    expect(body).toHaveProperty('platforms');
    expect(body.updated_at).toBeTruthy();
    expect(typeof before.updated_at).toBe('string');
  });

  it('a DB CHECK constraint violation during update → 422 "Validation failed."', async () => {
    const id = insertBookItem();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSpy = mockDbErrorOnUpdate('SQLITE_CONSTRAINT_CHECK');

    const res = await PATCH(patchRequest(id, { listing_price: 500 }), params(id));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(errorSpy).toHaveBeenCalledWith('PATCH /api/items/[id] CHECK constraint:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('a DB UNIQUE constraint violation during update → 409 "Conflicts with an existing record."', async () => {
    const id = insertBookItem();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSpy = mockDbErrorOnUpdate('SQLITE_CONSTRAINT_UNIQUE');

    const res = await PATCH(patchRequest(id, { listing_price: 500 }), params(id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Conflicts with an existing record.');
    expect(errorSpy).toHaveBeenCalledWith('PATCH /api/items/[id] UNIQUE constraint:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('an unexpected DB error during update (no recognized constraint code) → 500 "Internal server error."', async () => {
    const id = insertBookItem();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSpy = mockDbErrorOnUpdate();

    const res = await PATCH(patchRequest(id, { listing_price: 500 }), params(id));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error.');
    expect(errorSpy).toHaveBeenCalledWith('PATCH /api/items/[id] error:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
