import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { assertTransitionAllowed, ALLOWED_TRANSITIONS } from '../lib/transitions';
import { centsToUSD, usdToCents } from '../lib/money';
import { normalizeISBN } from '../lib/isbn';
import db from '../lib/db';

// ---------------------------------------------------------------------------
// 1. Unit: lib/transitions.ts
// ---------------------------------------------------------------------------

describe('transitions — valid paths', () => {
  it('Unlisted → Listed', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow());
  it('Unlisted → Donated', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Donated')).not.toThrow());
  it('Unlisted → Discarded', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Discarded')).not.toThrow());
  it('Listed → Unlisted', () =>
    expect(() => assertTransitionAllowed('Listed', 'Unlisted')).not.toThrow());
  it('Listed → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow());
  it('Listed → Removed', () =>
    expect(() => assertTransitionAllowed('Listed', 'Removed')).not.toThrow());
  it('Listed → Donated', () =>
    expect(() => assertTransitionAllowed('Listed', 'Donated')).not.toThrow());
  it('Listed → Discarded', () =>
    expect(() => assertTransitionAllowed('Listed', 'Discarded')).not.toThrow());
  it('Sale Pending → Listed', () =>
    expect(() => assertTransitionAllowed('Sale Pending', 'Listed')).not.toThrow());
  it('Sale Pending → Sold', () =>
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow());
});

describe('transitions — invalid paths (AC4)', () => {
  it('Sold → Listed is rejected (terminal)', () =>
    expect(() => assertTransitionAllowed('Sold', 'Listed')).toThrow(
      'Transition Sold → Listed is not permitted.',
    ));
  it('Sold → Unlisted', () =>
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow());
  it('Sold → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Sold', 'Sale Pending')).toThrow());
  it('Sold → Donated', () =>
    expect(() => assertTransitionAllowed('Sold', 'Donated')).toThrow());
  it('Sold → Discarded', () =>
    expect(() => assertTransitionAllowed('Sold', 'Discarded')).toThrow());
  it('Listed → Sold (must go via Sale Pending)', () =>
    expect(() => assertTransitionAllowed('Listed', 'Sold')).toThrow());
  it('Unlisted → Sold', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Sold')).toThrow());
  it('Unlisted → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Sale Pending')).toThrow());
  it('Removed → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Removed', 'Listed')).toThrow());
  it('Donated → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Donated', 'Listed')).toThrow());
  it('Discarded → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Discarded', 'Listed')).toThrow());
  it('error message uses arrow character', () =>
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow(
      'Transition Sold → Unlisted is not permitted.',
    ));
});

describe('transitions — ALLOWED_TRANSITIONS set sizes', () => {
  it('Sold is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Sold'].size).toBe(0));
  it('Removed is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Removed'].size).toBe(0));
  it('Donated is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Donated'].size).toBe(0));
  it('Discarded is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Discarded'].size).toBe(0));
  it('Unlisted has 3 transitions', () => expect(ALLOWED_TRANSITIONS['Unlisted'].size).toBe(3));
  it('Listed has 5 transitions', () => expect(ALLOWED_TRANSITIONS['Listed'].size).toBe(5));
  it('Sale Pending has 2 transitions', () => expect(ALLOWED_TRANSITIONS['Sale Pending'].size).toBe(2));
});

// ---------------------------------------------------------------------------
// 2. Unit: lib/money.ts
// ---------------------------------------------------------------------------

describe('centsToUSD', () => {
  it('0 → "0.00"', () => expect(centsToUSD(0)).toBe('0.00'));
  it('150 → "1.50"', () => expect(centsToUSD(150)).toBe('1.50'));
  it('5 → "0.05"', () => expect(centsToUSD(5)).toBe('0.05'));
  it('999 → "9.99"', () => expect(centsToUSD(999)).toBe('9.99'));
  it('10000 → "100.00"', () => expect(centsToUSD(10000)).toBe('100.00'));
  it('100000000 → "1000000.00" (max)', () => expect(centsToUSD(100000000)).toBe('1000000.00'));
  it('-150 → "-1.50" (negative)', () => expect(centsToUSD(-150)).toBe('-1.50'));
  it('-5 → "-0.05"', () => expect(centsToUSD(-5)).toBe('-0.05'));
});

describe('usdToCents', () => {
  it('"1.50" → 150', () => expect(usdToCents('1.50')).toBe(150));
  it('"0.00" → 0', () => expect(usdToCents('0.00')).toBe(0));
  it('"0.05" → 5', () => expect(usdToCents('0.05')).toBe(5));
  it('"9.99" → 999', () => expect(usdToCents('9.99')).toBe(999));
  it('number 1.5 → 150', () => expect(usdToCents(1.5)).toBe(150));
  it('"1.005" rounds up → 101', () => expect(usdToCents('1.005')).toBe(101));
  it('"1.004" rounds down → 100', () => expect(usdToCents('1.004')).toBe(100));
  it('negative string throws', () => expect(() => usdToCents('-1.00')).toThrow());
  it('negative number throws', () => expect(() => usdToCents(-1)).toThrow());
  it('non-numeric string throws', () => expect(() => usdToCents('abc')).toThrow());
  it('empty string throws', () => expect(() => usdToCents('')).toThrow());
  it('"1000001.00" exceeds max throws', () => expect(() => usdToCents('1000001.00')).toThrow());
  it('number 10000001 exceeds max throws', () => expect(() => usdToCents(10000001)).toThrow());
});

// ---------------------------------------------------------------------------
// 3. Unit: lib/isbn.ts
// ---------------------------------------------------------------------------

describe('normalizeISBN', () => {
  it('ISBN-10 with hyphens → ISBN-13', () =>
    expect(normalizeISBN('0-306-40615-2')).toBe('9780306406157'));
  it('ISBN-10 no hyphens → ISBN-13', () =>
    expect(normalizeISBN('0306406152')).toBe('9780306406157'));
  it('ISBN-13 passthrough', () =>
    expect(normalizeISBN('9780306406157')).toBe('9780306406157'));
  it('ISBN-13 with hyphens → stripped', () =>
    expect(normalizeISBN('978-0-306-40615-7')).toBe('9780306406157'));
  it('invalid ISBN throws', () =>
    expect(() => normalizeISBN('invalid')).toThrow('Invalid ISBN format.'));
  it('too-short string throws', () =>
    expect(() => normalizeISBN('12345')).toThrow());
  it('empty string throws', () =>
    expect(() => normalizeISBN('')).toThrow());
});

describe('lookupISBN', () => {
  it.skip('lookupISBN — network call skipped in unit mode', () => {});
});

// ---------------------------------------------------------------------------
// 4. Integration: DB layer (uses real SQLite, cleaned before each test)
// ---------------------------------------------------------------------------

describe('DB integration', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
  });

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

// ---------------------------------------------------------------------------
// 5. Integration: API (describe.skip — requires running server on :3000)
// ---------------------------------------------------------------------------

describe.skip('API integration (requires running server on localhost:3000)', () => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
  let itemId: string;

  it('AC2: POST /api/items manual entry (category=book) → 201, status Unlisted, platforms []', async () => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'Manual Entry Book',
        author: 'Jane Smith',
        condition: 'Good',
        acquisition_cost: 1000,
        acquisition_date: '2024-01-01',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    itemId = data.id;
    expect(data.status).toBe('Unlisted');
    expect(data.platforms).toEqual([]);
  });

  it('GET /api/items lists items with pagination envelope', async () => {
    const res = await fetch(`${base}/api/items`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('AC6: GET /api/items?q=manual is case-insensitive', async () => {
    const res = await fetch(`${base}/api/items?q=MANUAL`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.some((b: { title: string }) => b.title.toLowerCase().includes('manual')),
    ).toBe(true);
  });

  it('AC7: GET /api/items?condition=Good filters correctly', async () => {
    const res = await fetch(`${base}/api/items?condition=Good`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.every((b: { condition: string }) => b.condition === 'Good'),
    ).toBe(true);
  });

  it('GET /api/items/[id] returns item with platforms and price_history arrays', async () => {
    const res = await fetch(`${base}/api/items/${itemId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.platforms)).toBe(true);
    expect(Array.isArray(data.price_history)).toBe(true);
  });

  it('AC5: PATCH /api/items/[id] two price updates → price_history has entries', async () => {
    await fetch(`${base}/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1500 }),
    });

    const res2 = await fetch(`${base}/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 2000 }),
    });
    expect(res2.status).toBe(200);

    const detail = await (await fetch(`${base}/api/items/${itemId}`)).json();
    expect(detail.price_history.length).toBeGreaterThanOrEqual(1);
    const last = detail.price_history[detail.price_history.length - 1];
    expect(last).toHaveProperty('previous_price');
    expect(last).toHaveProperty('new_price');
    expect(last).toHaveProperty('changed_at');
  });

  it('status: Unlisted → Listed', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBe(200);
  });

  it('status: Listed → Sale Pending', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Sale Pending' }),
    });
    expect(res.status).toBe(200);
  });

  it('AC3: Sale Pending → Sold; gross_profit = sale_price - acquisition_cost', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Sold',
        sale_price: 2000,
        sale_platform: 'eBay',
        sale_date: '2024-06-01',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('Sold');
    // acquisition_cost=1000, sale_price=2000 → gross_profit=1000
    expect(data.gross_profit).toBe(1000);
  });

  it('AC4: Sold → Listed rejected; item remains Sold', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const detail = await (await fetch(`${base}/api/items/${itemId}`)).json();
    expect(detail.status).toBe('Sold');
  });

  it('AC10: GET /api/export → CSV with all data model fields', async () => {
    const res = await fetch(`${base}/api/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/i);
    const text = await res.text();
    const header = text.split('\n')[0];
    expect(header).toMatch(/title/i);
    expect(header).toMatch(/author/i);
    expect(header).toMatch(/sale_price/i);
    expect(header).toMatch(/sale_date/i);
    expect(header).toMatch(/acquisition_cost/i);
  });

  it('AC9: POST /api/import 50 rows → imported=48, 2 errors with row and fields', async () => {
    const header = 'title,author,condition,acquisition_cost_usd,acquisition_date';
    const valid = Array.from({ length: 48 }, (_, i) =>
      `Import Book ${i + 1},Author ${i + 1},Good,1000,2024-03-01`,
    ).join('\n');
    // Row 49: missing title; Row 50: missing acquisition_cost
    const bad1 = ',No Title Author,Good,1000,2024-03-01';
    const bad2 = 'No Cost Book,No Cost Author,Good,,2024-03-01';
    const csv = [header, valid, bad1, bad2].join('\n');

    const formData = new FormData();
    formData.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');

    const res = await fetch(`${base}/api/import`, { method: 'POST', body: formData });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(48);
    expect(data.errors).toHaveLength(2);
    expect(data.errors[0]).toHaveProperty('row');
    expect(data.errors[0]).toHaveProperty('fields');
  });

  it('AC11: POST /api/items without isbn works (ISBN outage simulation)', async () => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'No ISBN Book',
        author: 'Author Y',
        condition: 'Acceptable',
        acquisition_cost: 500,
        acquisition_date: '2024-02-15',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('Unlisted');
  });

  it('GET /api/dashboard returns held_count, held_acquisition_cost, by_condition, by_status', async () => {
    const res = await fetch(`${base}/api/dashboard`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('held_count');
    expect(data).toHaveProperty('held_acquisition_cost');
    expect(data).toHaveProperty('by_condition');
    expect(data).toHaveProperty('by_status');
  });

  it('D1: POST status Listed without listing_price → 422 (not 500); succeeds after PATCH sets a price', async () => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'D1 Regression Book',
        author: 'Author D1',
        condition: 'Good',
        acquisition_cost: 500,
        acquisition_date: '2024-01-01',
      }),
    });
    const { id } = await created.json();

    const attempt = await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(attempt.status).toBe(422);
    const attemptBody = await attempt.json();
    expect(attemptBody.error).toMatch(/listing_price/);

    await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1200 }),
    });

    const retry = await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.status).toBe('Listed');
  });

  it('D3: PATCH listing_price null on a Listed item → 422 (not 500)', async () => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'D3 Regression Book',
        author: 'Author D3',
        condition: 'Good',
        acquisition_cost: 700,
        acquisition_date: '2024-01-01',
      }),
    });
    const { id } = await created.json();

    await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1500 }),
    });
    await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });

    const res = await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: null }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/listing_price/);
  });

  it('D2: POST /api/import with a duplicate ISBN reports a per-row error and still imports the other valid rows (does not lose the whole batch)', async () => {
    const csv = [
      'title,author,condition,acquisition_cost_usd,acquisition_date,isbn',
      'D2 Regression Book A,Auth A,Good,5.00,2024-01-01,9780306406157',
      'D2 Regression Book B,Auth B,Good,6.00,2024-01-02,9780306406157',
      'D2 Regression Book C,Auth C,Good,7.00,2024-01-03,',
    ].join('\n');

    const formData = new FormData();
    formData.append('file', new Blob([csv], { type: 'text/csv' }), 'dup-isbn.csv');

    const res = await fetch(`${base}/api/import`, { method: 'POST', body: formData });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(2);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].row).toBe(3);
    expect(data.errors[0].fields).toContain('isbn');

    const list = await (await fetch(`${base}/api/items?title=D2 Regression`)).json();
    expect(list.total).toBe(2);
  });
});
