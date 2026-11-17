import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { assertTransitionAllowed } from '../lib/transitions';
import db from '../lib/db';

// ---------------------------------------------------------------------------
// 4. Integration: DB layer (uses real SQLite, cleaned before each test)
// ---------------------------------------------------------------------------

const setupDBIntegration = () => {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
};

/** Insert a book item (items + book_details), mirroring POST /api/items. Returns the id. */
function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Test Author',
    publisher: 'Test Publisher',
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

/** Insert a clothing item (items + clothing_details), mirroring POST /api/items. Returns the id. */
function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'TestBrand',
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

/** Insert a price_history row */
function recordPriceChange(itemId: string, prev: number, next: number) {
  db.prepare(`
    INSERT INTO price_history (id, item_id, previous_price, new_price, changed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(uuidv4(), itemId, prev, next);
}

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // AC2: manual entry without ISBN
  it('AC2: manual entry without ISBN inserts successfully with Unlisted status', () => {
    const id = insertBookItem({ isbn: null });
    const row = db.prepare('SELECT title, status FROM items WHERE id = ?').get(id) as {
      title: string; status: string;
    };
    expect(row.title).toBe('Test Book');
    expect(row.status).toBe('Unlisted');
  });

  // AC1: entry with ISBN stores isbn field
  it('AC1: entry with ISBN stores isbn column, status Unlisted', () => {
    const id = insertBookItem({ isbn: '9780306406157' });
    const row = db.prepare(`
      SELECT bd.isbn, i.status FROM items i JOIN book_details bd ON bd.item_id = i.id
      WHERE i.id = ?
    `).get(id) as { isbn: string; status: string };
    expect(row.isbn).toBe('9780306406157');
    expect(row.status).toBe('Unlisted');
  });

  it('new book item defaults to Unlisted status', () => {
    const id = insertBookItem();
    const row = db.prepare('SELECT status FROM items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('Unlisted');
  });

  // AC5: price change records price_history
  it('AC5: price change creates price_history entry with all required fields', () => {
    const id = insertBookItem();
    recordPriceChange(id, 0, 1500);

    const row = db.prepare('SELECT * FROM price_history WHERE item_id = ?').get(id) as {
      previous_price: number; new_price: number; changed_at: string;
    };
    expect(row.previous_price).toBe(0);
    expect(row.new_price).toBe(1500);
    expect(row.changed_at).toBeTruthy();
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('AC5: two price changes → history shows both entries in order', () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1500 });
    recordPriceChange(id, 0, 1500);
    db.prepare("UPDATE items SET listing_price = 2000 WHERE id = ?").run(id);
    recordPriceChange(id, 1500, 2000);

    const history = db.prepare(
      'SELECT previous_price, new_price FROM price_history WHERE item_id = ? ORDER BY changed_at',
    ).all(id) as Array<{ previous_price: number; new_price: number }>;

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ previous_price: 0, new_price: 1500 });
    expect(history[1]).toMatchObject({ previous_price: 1500, new_price: 2000 });
  });

  // DR-7: previous_price/new_price are nullable (migration 002). NULL means
  // "no prior price" / "price cleared", distinct from a real 0. Locks in the
  // table rebuild so a regression back to INTEGER NOT NULL fails here.
  it('DR-7: price_history accepts NULL previous_price and preserves it (not coerced to 0)', () => {
    const id = insertBookItem();
    db.prepare(`
      INSERT INTO price_history (id, item_id, previous_price, new_price, changed_at)
      VALUES (?, ?, NULL, ?, datetime('now'))
    `).run(uuidv4(), id, 1500);

    const row = db.prepare(
      'SELECT previous_price, new_price FROM price_history WHERE item_id = ?',
    ).get(id) as { previous_price: number | null; new_price: number | null };
    expect(row.previous_price).toBeNull();
    expect(row.new_price).toBe(1500);
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // item_platforms
  it('item_platforms stores multiple platforms for a book item', () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'AbeBooks');

    const platforms = db.prepare(
      'SELECT platform FROM item_platforms WHERE item_id = ? ORDER BY platform',
    ).all(id) as Array<{ platform: string }>;
    expect(platforms.map((p) => p.platform)).toEqual(['AbeBooks', 'eBay']);
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // AC3: gross_profit = sale_price - acquisition_cost
  it('AC3: gross_profit computed as sale_price - acquisition_cost', () => {
    const id = insertBookItem({
      acquisition_cost: 500,
      status: 'Sold',
      listing_price: 1500,
      sale_price: 1500,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });
    const row = db.prepare(
      'SELECT (sale_price - acquisition_cost) AS gross_profit FROM items WHERE id = ?',
    ).get(id) as { gross_profit: number };
    expect(row.gross_profit).toBe(1000);
  });

  it('AC3: full lifecycle Unlisted → Listed → Sale Pending → Sold', () => {
    const id = insertBookItem({ acquisition_cost: 300 });

    // Unlisted → Listed
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Listed', listing_price=800, updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Listed → Sale Pending
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Sale Pending', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Sale Pending → Sold
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Sold', sale_price=800, sale_platform='eBay', sale_date='2024-06-01', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    const row = db.prepare(
      'SELECT status, (sale_price - acquisition_cost) AS gross_profit FROM items WHERE id=?',
    ).get(id) as { status: string; gross_profit: number };
    expect(row.status).toBe('Sold');
    expect(row.gross_profit).toBe(500);
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // AC4: Sold → Listed rejected
  it('AC4: assertTransitionAllowed Sold→Listed throws; DB row remains Sold', () => {
    const id = insertBookItem({
      status: 'Sold',
      listing_price: 1000,
      sale_price: 1000,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });

    expect(() => assertTransitionAllowed('Sold', 'Listed')).toThrow();

    // Caller must not update the DB after the throw — row is still Sold
    const row = db.prepare('SELECT status FROM items WHERE id=?').get(id) as { status: string };
    expect(row.status).toBe('Sold');
  });

  // AC6: case-insensitive partial title search
  it('AC6: case-insensitive partial title search via LIKE', () => {
    insertBookItem({ title: 'The Great Gatsby' });
    insertBookItem({ title: 'Great Expectations' });
    insertBookItem({ title: 'A Farewell to Arms' });

    const rows = db.prepare(
      "SELECT title FROM items WHERE title LIKE ?",
    ).all('%great%') as Array<{ title: string }>;
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toContain('The Great Gatsby');
    expect(titles).toContain('Great Expectations');
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // AC7: filter by condition
  it('AC7: filtering by condition=Very Good returns only Very Good books', () => {
    insertBookItem({ condition: 'Very Good', title: 'Book A' });
    insertBookItem({ condition: 'Good', title: 'Book B' });
    insertBookItem({ condition: 'Very Good', title: 'Book C' });
    insertBookItem({ condition: 'Acceptable', title: 'Book D' });

    const rows = db.prepare(`
      SELECT i.title FROM items i JOIN book_details bd ON bd.item_id = i.id
      WHERE bd.condition = 'Very Good'
    `).all() as Array<{ title: string }>;
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Book A', 'Book C']);
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // AC8: dashboard held total
  it('AC8: held total = sum of acquisition_cost for Unlisted+Listed+Sale Pending only', () => {
    insertBookItem({ acquisition_cost: 1000, status: 'Unlisted' });
    insertBookItem({ acquisition_cost: 2000, status: 'Listed', listing_price: 3000 });
    insertBookItem({ acquisition_cost: 500, status: 'Sale Pending', listing_price: 1000 });
    insertBookItem({
      acquisition_cost: 300,
      status: 'Sold',
      listing_price: 700,
      sale_price: 700,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });

    const row = db.prepare(`
      SELECT SUM(acquisition_cost) AS held_total
      FROM items
      WHERE status IN ('Unlisted', 'Listed', 'Sale Pending')
    `).get() as { held_total: number };
    expect(row.held_total).toBe(3500);
  });

  // DB constraint enforcement
  it('DB rejects Listed book item with null listing_price (schema constraint)', () => {
    expect(() =>
      insertBookItem({ status: 'Listed', listing_price: null }),
    ).toThrow();
  });

  it('DB rejects Sold book item with null sale_price (schema constraint)', () => {
    expect(() =>
      insertBookItem({
        status: 'Sold',
        listing_price: 1000,
        sale_price: null,
        sale_platform: 'eBay',
        sale_date: '2024-06-01',
      }),
    ).toThrow();
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('DB rejects Sold book item with null sale_date (schema constraint)', () => {
    expect(() =>
      insertBookItem({
        status: 'Sold',
        listing_price: 1000,
        sale_price: 1000,
        sale_platform: 'eBay',
        sale_date: null,
      }),
    ).toThrow();
  });

  it('DB rejects Sold book item with null sale_platform (schema constraint)', () => {
    expect(() =>
      insertBookItem({
        status: 'Sold',
        listing_price: 1000,
        sale_price: 1000,
        sale_platform: null,
        sale_date: '2024-06-01',
      }),
    ).toThrow();
  });

  it('query by status=Listed returns only Listed items', () => {
    insertBookItem({ title: 'Listed A', status: 'Listed', listing_price: 500 });
    insertBookItem({ title: 'Unlisted B', status: 'Unlisted' });

    const rows = db.prepare(
      "SELECT title FROM items WHERE status = 'Listed'",
    ).all() as Array<{ title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Listed A');
  });

  it('item_platforms FK prevents orphan rows when foreign_keys=ON', () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');

    // Deleting the parent item must fail due to FK constraint
    expect(() =>
      db.prepare('DELETE FROM items WHERE id = ?').run(id),
    ).toThrow();
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  // ---------------------------------------------------------------------
  // Clothing category
  // ---------------------------------------------------------------------

  it('clothing: manual entry lands in clothing_details with correct fields, status Unlisted', () => {
    const id = insertClothingItem({
      title: 'Test Jacket',
      brand: 'Patagonia',
      size_label: 'L',
      color: 'Green',
      condition: 'NWT',
    });

    const row = db.prepare(`
      SELECT i.title, i.status, cd.brand, cd.size_label, cd.color, cd.condition
      FROM items i JOIN clothing_details cd ON cd.item_id = i.id
      WHERE i.id = ?
    `).get(id) as {
      title: string; status: string; brand: string; size_label: string;
      color: string; condition: string;
    };
    expect(row.title).toBe('Test Jacket');
    expect(row.status).toBe('Unlisted');
    expect(row.brand).toBe('Patagonia');
    expect(row.size_label).toBe('L');
    expect(row.color).toBe('Green');
    expect(row.condition).toBe('NWT');
  });

  it('cross-category condition rejection: clothing vocabulary in book_details.condition throws', () => {
    expect(() => insertBookItem({ condition: 'EUC' })).toThrow();
  });

  it('cross-category condition rejection: book vocabulary in clothing_details.condition throws', () => {
    expect(() => insertClothingItem({ condition: 'Very Good' })).toThrow();
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('clothing: full lifecycle Unlisted → Listed → Sale Pending → Sold (category-blind transitions)', () => {
    const id = insertClothingItem({ acquisition_cost: 1500 });

    // Unlisted → Listed
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Listed', listing_price=3000, updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Listed → Sale Pending
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Sale Pending', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Sale Pending → Sold
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow();
    db.prepare(
      "UPDATE items SET status='Sold', sale_price=2800, sale_platform='Poshmark', sale_date='2024-07-01', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    const row = db.prepare(
      'SELECT status, sale_price, sale_platform, sale_date FROM items WHERE id=?',
    ).get(id) as {
      status: string; sale_price: number; sale_platform: string; sale_date: string;
    };
    expect(row.status).toBe('Sold');
    expect(row.sale_price).toBe(2800);
    expect(row.sale_platform).toBe('Poshmark');
    expect(row.sale_date).toBe('2024-07-01');
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('item_platforms: two platform rows for a clothing item are both retrievable; duplicate rejected by UNIQUE', () => {
    const id = insertClothingItem({ status: 'Listed', listing_price: 2500 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'Poshmark');
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'Depop');

    const platforms = db.prepare(
      'SELECT platform FROM item_platforms WHERE item_id = ? ORDER BY platform',
    ).all(id) as Array<{ platform: string }>;
    expect(platforms.map((p) => p.platform)).toEqual(['Depop', 'Poshmark']);

    // Duplicate (item_id, platform) violates UNIQUE(item_id, platform)
    expect(() =>
      db.prepare(
        `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
      ).run(uuidv4(), id, 'Poshmark'),
    ).toThrow();
  });

  it('items_category_immutable trigger rejects UPDATE items SET category on a book item', () => {
    const id = insertBookItem();
    expect(() =>
      db.prepare("UPDATE items SET category = 'clothing' WHERE id = ?").run(id),
    ).toThrow();
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('item_photos: rows for a clothing item are retrievable in sort_order', () => {
    const id = insertClothingItem();
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(uuidv4(), id, 'photo-3.jpg', 3);
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(uuidv4(), id, 'photo-1.jpg', 1);
    db.prepare(
      'INSERT INTO item_photos (id, item_id, path, sort_order) VALUES (?, ?, ?, ?)',
    ).run(uuidv4(), id, 'photo-2.jpg', 2);

    const photos = db.prepare(
      'SELECT path, sort_order FROM item_photos WHERE item_id = ? ORDER BY sort_order',
    ).all(id) as Array<{ path: string; sort_order: number }>;
    expect(photos.map((p) => p.path)).toEqual(['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg']);
    expect(photos.map((p) => p.sort_order)).toEqual([1, 2, 3]);
  });
});

describe('DB integration', () => {
  beforeEach(setupDBIntegration);

  it('price_history is category-agnostic: records price changes for a clothing item', () => {
    const id = insertClothingItem();
    recordPriceChange(id, 0, 2500);
    db.prepare("UPDATE items SET listing_price = 2200 WHERE id = ?").run(id);
    recordPriceChange(id, 2500, 2200);

    const history = db.prepare(
      'SELECT previous_price, new_price FROM price_history WHERE item_id = ? ORDER BY changed_at',
    ).all(id) as Array<{ previous_price: number; new_price: number }>;

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ previous_price: 0, new_price: 2500 });
    expect(history[1]).toMatchObject({ previous_price: 2500, new_price: 2200 });
  });
});
