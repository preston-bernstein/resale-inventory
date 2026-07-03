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
    db.exec('DELETE FROM price_history; DELETE FROM book_platforms; DELETE FROM books;');
  });

  /** Insert a book row via raw SQL. Returns the generated id. */
  function insertBook(overrides: Record<string, unknown> = {}): string {
    const id = uuidv4();
    const defaults: Record<string, unknown> = {
      id,
      isbn: null,
      title: 'Test Book',
      author: 'Test Author',
      publisher: 'Test Publisher',
      condition: 'Good',
      acquisition_cost: 1000,
      acquisition_date: '2024-01-01',
      status: 'Unlisted',
      listing_price: null,
      sale_price: null,
      sale_platform: null,
      sale_date: null,
    };
    const book = { ...defaults, ...overrides, id };
    db.prepare(`
      INSERT INTO books
        (id, isbn, title, author, publisher, condition, acquisition_cost,
         acquisition_date, status, listing_price, sale_price, sale_platform, sale_date)
      VALUES
        (@id, @isbn, @title, @author, @publisher, @condition, @acquisition_cost,
         @acquisition_date, @status, @listing_price, @sale_price, @sale_platform, @sale_date)
    `).run(book);
    return id;
  }

  /** Insert a price_history row */
  function recordPriceChange(bookId: string, prev: number, next: number) {
    db.prepare(`
      INSERT INTO price_history (id, book_id, previous_price, new_price, changed_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), bookId, prev, next);
  }

  // AC2: manual entry without ISBN
  it('AC2: manual entry without ISBN inserts successfully with Unlisted status', () => {
    const id = insertBook({ isbn: null });
    const row = db.prepare('SELECT title, status FROM books WHERE id = ?').get(id) as {
      title: string; status: string;
    };
    expect(row.title).toBe('Test Book');
    expect(row.status).toBe('Unlisted');
  });

  // AC1: entry with ISBN stores isbn field
  it('AC1: entry with ISBN stores isbn column, status Unlisted', () => {
    const id = insertBook({ isbn: '9780306406157' });
    const row = db.prepare('SELECT isbn, status FROM books WHERE id = ?').get(id) as {
      isbn: string; status: string;
    };
    expect(row.isbn).toBe('9780306406157');
    expect(row.status).toBe('Unlisted');
  });

  it('new book defaults to Unlisted status', () => {
    const id = insertBook();
    const row = db.prepare('SELECT status FROM books WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('Unlisted');
  });

  // AC5: price change records price_history
  it('AC5: price change creates price_history entry with all required fields', () => {
    const id = insertBook();
    recordPriceChange(id, 0, 1500);

    const row = db.prepare('SELECT * FROM price_history WHERE book_id = ?').get(id) as {
      previous_price: number; new_price: number; changed_at: string;
    };
    expect(row.previous_price).toBe(0);
    expect(row.new_price).toBe(1500);
    expect(row.changed_at).toBeTruthy();
  });

  it('AC5: two price changes → history shows both entries in order', () => {
    const id = insertBook({ status: 'Listed', listing_price: 1500 });
    recordPriceChange(id, 0, 1500);
    db.prepare("UPDATE books SET listing_price = 2000 WHERE id = ?").run(id);
    recordPriceChange(id, 1500, 2000);

    const history = db.prepare(
      'SELECT previous_price, new_price FROM price_history WHERE book_id = ? ORDER BY changed_at',
    ).all(id) as Array<{ previous_price: number; new_price: number }>;

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ previous_price: 0, new_price: 1500 });
    expect(history[1]).toMatchObject({ previous_price: 1500, new_price: 2000 });
  });

  // book_platforms
  it('book_platforms stores multiple platforms for a book', () => {
    const id = insertBook({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO book_platforms (id, book_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');
    db.prepare(
      `INSERT INTO book_platforms (id, book_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'AbeBooks');

    const platforms = db.prepare(
      'SELECT platform FROM book_platforms WHERE book_id = ? ORDER BY platform',
    ).all(id) as Array<{ platform: string }>;
    expect(platforms.map((p) => p.platform)).toEqual(['AbeBooks', 'eBay']);
  });

  // AC3: gross_profit = sale_price - acquisition_cost
  it('AC3: gross_profit computed as sale_price - acquisition_cost', () => {
    const id = insertBook({
      acquisition_cost: 500,
      status: 'Sold',
      listing_price: 1500,
      sale_price: 1500,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });
    const row = db.prepare(
      'SELECT (sale_price - acquisition_cost) AS gross_profit FROM books WHERE id = ?',
    ).get(id) as { gross_profit: number };
    expect(row.gross_profit).toBe(1000);
  });

  it('AC3: full lifecycle Unlisted → Listed → Sale Pending → Sold', () => {
    const id = insertBook({ acquisition_cost: 300 });

    // Unlisted → Listed
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow();
    db.prepare(
      "UPDATE books SET status='Listed', listing_price=800, updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Listed → Sale Pending
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow();
    db.prepare(
      "UPDATE books SET status='Sale Pending', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    // Sale Pending → Sold
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow();
    db.prepare(
      "UPDATE books SET status='Sold', sale_price=800, sale_platform='eBay', sale_date='2024-06-01', updated_at=datetime('now') WHERE id=?",
    ).run(id);

    const row = db.prepare(
      'SELECT status, (sale_price - acquisition_cost) AS gross_profit FROM books WHERE id=?',
    ).get(id) as { status: string; gross_profit: number };
    expect(row.status).toBe('Sold');
    expect(row.gross_profit).toBe(500);
  });

  // AC4: Sold → Listed rejected
  it('AC4: assertTransitionAllowed Sold→Listed throws; DB row remains Sold', () => {
    const id = insertBook({
      status: 'Sold',
      listing_price: 1000,
      sale_price: 1000,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });

    expect(() => assertTransitionAllowed('Sold', 'Listed')).toThrow();

    // Caller must not update the DB after the throw — row is still Sold
    const row = db.prepare('SELECT status FROM books WHERE id=?').get(id) as { status: string };
    expect(row.status).toBe('Sold');
  });

  // AC6: case-insensitive partial title search
  it('AC6: case-insensitive partial title search via LIKE', () => {
    insertBook({ title: 'The Great Gatsby' });
    insertBook({ title: 'Great Expectations' });
    insertBook({ title: 'A Farewell to Arms' });

    const rows = db.prepare(
      "SELECT title FROM books WHERE title LIKE ?",
    ).all('%great%') as Array<{ title: string }>;
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toContain('The Great Gatsby');
    expect(titles).toContain('Great Expectations');
  });

  // AC7: filter by condition
  it('AC7: filtering by condition=Very Good returns only Very Good books', () => {
    insertBook({ condition: 'Very Good', title: 'Book A' });
    insertBook({ condition: 'Good', title: 'Book B' });
    insertBook({ condition: 'Very Good', title: 'Book C' });
    insertBook({ condition: 'Acceptable', title: 'Book D' });

    const rows = db.prepare(
      "SELECT title FROM books WHERE condition = 'Very Good'",
    ).all() as Array<{ title: string }>;
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Book A', 'Book C']);
  });

  // AC8: dashboard held total
  it('AC8: held total = sum of acquisition_cost for Unlisted+Listed+Sale Pending only', () => {
    insertBook({ acquisition_cost: 1000, status: 'Unlisted' });
    insertBook({ acquisition_cost: 2000, status: 'Listed', listing_price: 3000 });
    insertBook({ acquisition_cost: 500, status: 'Sale Pending', listing_price: 1000 });
    insertBook({
      acquisition_cost: 300,
      status: 'Sold',
      listing_price: 700,
      sale_price: 700,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });

    const row = db.prepare(`
      SELECT SUM(acquisition_cost) AS held_total
      FROM books
      WHERE status IN ('Unlisted', 'Listed', 'Sale Pending')
    `).get() as { held_total: number };
    expect(row.held_total).toBe(3500);
  });

  // DB constraint enforcement
  it('DB rejects Listed book with null listing_price (schema constraint)', () => {
    expect(() =>
      insertBook({ status: 'Listed', listing_price: null }),
    ).toThrow();
  });

  it('DB rejects Sold book with null sale_price (schema constraint)', () => {
    expect(() =>
      insertBook({
        status: 'Sold',
        listing_price: 1000,
        sale_price: null,
        sale_platform: 'eBay',
        sale_date: '2024-06-01',
      }),
    ).toThrow();
  });

  it('DB rejects Sold book with null sale_date (schema constraint)', () => {
    expect(() =>
      insertBook({
        status: 'Sold',
        listing_price: 1000,
        sale_price: 1000,
        sale_platform: 'eBay',
        sale_date: null,
      }),
    ).toThrow();
  });

  it('DB rejects Sold book with null sale_platform (schema constraint)', () => {
    expect(() =>
      insertBook({
        status: 'Sold',
        listing_price: 1000,
        sale_price: 1000,
        sale_platform: null,
        sale_date: '2024-06-01',
      }),
    ).toThrow();
  });

  it('query by status=Listed returns only Listed books', () => {
    insertBook({ title: 'Listed A', status: 'Listed', listing_price: 500 });
    insertBook({ title: 'Unlisted B', status: 'Unlisted' });

    const rows = db.prepare(
      "SELECT title FROM books WHERE status = 'Listed'",
    ).all() as Array<{ title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Listed A');
  });

  it('book_platforms FK prevents orphan rows when foreign_keys=ON', () => {
    const id = insertBook({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO book_platforms (id, book_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');

    // Deleting the parent book must fail due to FK constraint
    expect(() =>
      db.prepare('DELETE FROM books WHERE id = ?').run(id),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Integration: API (describe.skip — requires running server on :3000)
// ---------------------------------------------------------------------------

describe.skip('API integration (requires running server on localhost:3000)', () => {
  const base = 'http://localhost:3000';
  let bookId: string;

  it('AC2: POST /api/books manual entry → 201, status Unlisted, platforms []', async () => {
    const res = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Manual Entry Book',
        author: 'Jane Smith',
        condition: 'Good',
        acquisition_cost: 1000,
        acquisition_date: '2024-01-01',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    bookId = data.id;
    expect(data.status).toBe('Unlisted');
    expect(data.platforms).toEqual([]);
  });

  it('GET /api/books lists books with pagination envelope', async () => {
    const res = await fetch(`${base}/api/books`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('AC6: GET /api/books?q=manual is case-insensitive', async () => {
    const res = await fetch(`${base}/api/books?q=MANUAL`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.some((b: { title: string }) => b.title.toLowerCase().includes('manual')),
    ).toBe(true);
  });

  it('AC7: GET /api/books?condition=Good filters correctly', async () => {
    const res = await fetch(`${base}/api/books?condition=Good`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.every((b: { condition: string }) => b.condition === 'Good'),
    ).toBe(true);
  });

  it('GET /api/books/[id] returns book with platforms and price_history arrays', async () => {
    const res = await fetch(`${base}/api/books/${bookId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.platforms)).toBe(true);
    expect(Array.isArray(data.price_history)).toBe(true);
  });

  it('AC5: PATCH /api/books/[id] two price updates → price_history has entries', async () => {
    await fetch(`${base}/api/books/${bookId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1500 }),
    });

    const res2 = await fetch(`${base}/api/books/${bookId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 2000 }),
    });
    expect(res2.status).toBe(200);

    const detail = await (await fetch(`${base}/api/books/${bookId}`)).json();
    expect(detail.price_history.length).toBeGreaterThanOrEqual(1);
    const last = detail.price_history[detail.price_history.length - 1];
    expect(last).toHaveProperty('previous_price');
    expect(last).toHaveProperty('new_price');
    expect(last).toHaveProperty('changed_at');
  });

  it('status: Unlisted → Listed', async () => {
    const res = await fetch(`${base}/api/books/${bookId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBe(200);
  });

  it('status: Listed → Sale Pending', async () => {
    const res = await fetch(`${base}/api/books/${bookId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Sale Pending' }),
    });
    expect(res.status).toBe(200);
  });

  it('AC3: Sale Pending → Sold; gross_profit = sale_price - acquisition_cost', async () => {
    const res = await fetch(`${base}/api/books/${bookId}/status`, {
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

  it('AC4: Sold → Listed rejected; book remains Sold', async () => {
    const res = await fetch(`${base}/api/books/${bookId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const detail = await (await fetch(`${base}/api/books/${bookId}`)).json();
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
    const header = 'title,author,condition,acquisition_cost,acquisition_date';
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

  it('AC11: POST /api/books without isbn works (ISBN outage simulation)', async () => {
    const res = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
});
