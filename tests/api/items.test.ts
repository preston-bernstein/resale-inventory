import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { POST, GET } from '@/app/api/items/route';
import db from '@/lib/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/items${query}`);
}

function validBook(overrides: Record<string, unknown> = {}) {
  return {
    category: 'book',
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    publisher: 'Scribner',
    condition: 'Good',
    acquisition_cost: 500,
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

function validClothing(overrides: Record<string, unknown> = {}) {
  return {
    category: 'clothing',
    title: 'Denim Jacket',
    brand: 'Levi\'s',
    size_label: 'M',
    condition: 'EUC',
    acquisition_cost: 2000,
    acquisition_date: '2024-02-01',
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// POST /api/items
// ---------------------------------------------------------------------------

describe('POST /api/items', () => {
  beforeEach(cleanTables);

  it('creates a book item successfully → 201, flat row shape, status Unlisted', async () => {
    const res = await POST(postRequest(validBook()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.category).toBe('book');
    expect(body.title).toBe('The Great Gatsby');
    expect(body.author).toBe('F. Scott Fitzgerald');
    expect(body.publisher).toBe('Scribner');
    expect(body.condition).toBe('Good');
    expect(body.status).toBe('Unlisted');
    expect(body.acquisition_cost).toBe(500);
    expect(body.isbn).toBeNull();
  });

  it('creates a clothing item successfully → 201, flat row shape, status Unlisted', async () => {
    const res = await POST(postRequest(validClothing()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.category).toBe('clothing');
    expect(body.title).toBe('Denim Jacket');
    expect(body.brand).toBe("Levi's");
    expect(body.size_label).toBe('M');
    expect(body.condition).toBe('EUC');
    expect(body.status).toBe('Unlisted');
  });

  it('invalid JSON body → 400', async () => {
    const res = await POST(postRequest('{not valid json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body.');
  });

  it('internal server error is returned as 500 with a generic message when a DB write fails unexpectedly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO clothing_details')) {
        throw new Error('disk full');
      }
      return realPrepare(sql);
    });

    const res = await POST(postRequest(validClothing()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error.');
    expect(errorSpy).toHaveBeenCalledWith('POST /api/items error:', expect.any(Error));

    prepareSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('missing category → 422 with fields: [category]', async () => {
    const { category, ...rest } = validBook();
    const res = await POST(postRequest(rest));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toEqual(['category']);
  });

  it('invalid category value → 422 with fields: [category]', async () => {
    const res = await POST(postRequest(validBook({ category: 'shoes' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toEqual(['category']);
  });

  it('book missing title (and no ISBN to fall back on) → 422 with fields includes title', async () => {
    const res = await POST(postRequest(validBook({ title: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('title');
  });

  it('clothing missing title → 422 with fields includes title', async () => {
    // Unlike the book branch, the clothing branch has no ISBN-lookup
    // fallback logic that could mask this check — this exercises the
    // `if (!title) invalidFields.push('title')` line directly.
    const res = await POST(postRequest(validClothing({ title: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('title');
  });

  it('title exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validBook({ title: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('Stryker was here!');
  });

  it('title with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validBook({ title: '  The Great Gatsby  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('The Great Gatsby');
  });

  it('book missing author (and no ISBN to fall back on) → 422 with fields includes author', async () => {
    const res = await POST(postRequest(validBook({ author: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('author');
  });

  it('author exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validBook({ author: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.author).toBe('Stryker was here!');
  });

  it('author with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validBook({ author: '  Jane Austen  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.author).toBe('Jane Austen');
  });

  it('publisher exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validBook({ publisher: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publisher).toBe('Stryker was here!');
  });

  it('publisher with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validBook({ publisher: '  Scribner  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publisher).toBe('Scribner');
  });

  it('book with no publisher and no isbn creates successfully with publisher null', async () => {
    const { publisher, ...rest } = validBook();
    const res = await POST(postRequest(rest));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publisher).toBeNull();
  });

  it('book missing acquisition_cost → 422 with fields includes acquisition_cost', async () => {
    const { acquisition_cost, ...rest } = validBook();
    const res = await POST(postRequest(rest));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_cost');
  });

  it('negative acquisition_cost → 422 with fields includes acquisition_cost', async () => {
    const res = await POST(postRequest(validBook({ acquisition_cost: -5 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_cost');
  });

  it('non-integer acquisition_cost → 422 with fields includes acquisition_cost', async () => {
    const res = await POST(postRequest(validBook({ acquisition_cost: 5.5 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_cost');
  });

  it('acquisition_cost of exactly 0 is a valid boundary value', async () => {
    const res = await POST(postRequest(validBook({ acquisition_cost: 0 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.acquisition_cost).toBe(0);
  });

  it('acquisition_cost of exactly 100,000,000 is a valid upper-boundary value', async () => {
    const res = await POST(postRequest(validBook({ acquisition_cost: 100_000_000 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.acquisition_cost).toBe(100_000_000);
  });

  it('acquisition_cost of 100,000,001 exceeds the upper boundary → 422', async () => {
    const res = await POST(postRequest(validBook({ acquisition_cost: 100_000_001 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_cost');
  });

  it('invalid acquisition_date format → 422 with fields includes acquisition_date', async () => {
    const res = await POST(postRequest(validBook({ acquisition_date: '01/01/2024' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_date');
  });

  it('acquisition_date that is not a string (even if it stringifies to a valid date) → 422', async () => {
    // A single-element array stringifies to its element's own string form
    // ('2024-01-08'), which would slip past a naive `DATE_RE.test()` call
    // if the `typeof !== 'string'` guard weren't also enforced.
    const res = await POST(postRequest(validBook({ acquisition_date: ['2024-01-08'] })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('acquisition_date');
  });

  it('invalid condition for book category → 422 with fields includes condition', async () => {
    // 'EUC' is a clothing-only condition value
    const res = await POST(postRequest(validBook({ condition: 'EUC' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('condition');
  });

  it('invalid condition for clothing category → 422 with fields includes condition', async () => {
    // 'Good' is a book-only condition value
    const res = await POST(postRequest(validClothing({ condition: 'Good' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('condition');
  });

  it('clothing missing brand → 422 with fields includes brand', async () => {
    const res = await POST(postRequest(validClothing({ brand: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('brand');
  });

  it('brand of the wrong type (number) → 422 with fields includes brand (not a crash)', async () => {
    const res = await POST(postRequest(validClothing({ brand: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('brand');
  });

  it('brand exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validClothing({ brand: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand).toBe('Stryker was here!');
  });

  it('brand with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ brand: "  Levi's  " })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand).toBe("Levi's");
  });

  it('clothing missing size_label → 422 with fields includes size_label', async () => {
    const res = await POST(postRequest(validClothing({ size_label: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('size_label');
  });

  it('size_label of the wrong type (number) → 422 with fields includes size_label (not a crash)', async () => {
    const res = await POST(postRequest(validClothing({ size_label: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('size_label');
  });

  it('size_label exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validClothing({ size_label: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.size_label).toBe('Stryker was here!');
  });

  it('size_label with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ size_label: '  L  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.size_label).toBe('L');
  });

  it('clothing color of the wrong type (number) → 422 with fields includes color', async () => {
    const res = await POST(postRequest(validClothing({ color: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('color');
  });

  it('clothing color explicitly null is valid', async () => {
    const res = await POST(postRequest(validClothing({ color: null })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBeNull();
  });

  it('clothing color with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ color: '  Blue  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBe('Blue');
  });

  it('clothing material of the wrong type (number) → 422 with fields includes material', async () => {
    const res = await POST(postRequest(validClothing({ material: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('material');
  });

  it('clothing material explicitly null is valid', async () => {
    const res = await POST(postRequest(validClothing({ material: null })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.material).toBeNull();
  });

  it('clothing material is trimmed and persisted when provided', async () => {
    const res = await POST(postRequest(validClothing({ material: '  Wool  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.material).toBe('Wool');
  });

  it('clothing gender_department valid string is persisted', async () => {
    const res = await POST(postRequest(validClothing({ gender_department: 'Womens' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.gender_department).toBe('Womens');
  });

  it('clothing invalid gender_department type → 422 with fields includes gender_department', async () => {
    const res = await POST(postRequest(validClothing({ gender_department: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('gender_department');
  });

  it('clothing weight_oz valid positive integer is persisted', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: 16 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.weight_oz).toBe(16);
  });

  it('clothing negative weight_oz → 422 with fields includes weight_oz', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: -3 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('weight_oz');
  });

  it('clothing non-integer weight_oz → 422 with fields includes weight_oz', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: 3.2 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('weight_oz');
  });

  it('clothing negative measurement field → 422 with fields includes that field', async () => {
    const res = await POST(postRequest(validClothing({ waist_in: -1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('waist_in');
  });

  it('clothing item persists optional measurement fields when provided', async () => {
    const res = await POST(
      postRequest(validClothing({ waist_in: 30, pit_to_pit_in: 22.5, color: 'Blue' })),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.waist_in).toBe(30);
    expect(body.pit_to_pit_in).toBe(22.5);
    expect(body.color).toBe('Blue');
  });

  it('clothing item with omitted optional fields defaults them to null', async () => {
    const res = await POST(postRequest(validClothing()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBeNull();
    expect(body.material).toBeNull();
    expect(body.weight_oz).toBeNull();
    expect(body.gender_department).toBeNull();
  });

  it('invalid ISBN format → 422 "Invalid ISBN format."', async () => {
    const res = await POST(postRequest(validBook({ isbn: 'not-an-isbn' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Invalid ISBN format.');
  });

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubFoundResponse(payload: Record<string, unknown>) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      vi.mocked(fetch).mockResolvedValue({ ok: true, body: stream } as unknown as Response);
    }

    it('found lookup supplies title/author/publisher defaults when omitted from body', async () => {
      stubFoundResponse({
        'ISBN:9780306406157': {
          title: 'On Being a Scientist',
          authors: [{ name: 'Committee on Science' }],
          publishers: [{ name: 'National Academies Press' }],
        },
      });

      const res = await POST(
        postRequest({
          category: 'book',
          isbn: '9780306406157',
          condition: 'Good',
          acquisition_cost: 1000,
          acquisition_date: '2024-01-01',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('On Being a Scientist');
      expect(body.author).toBe('Committee on Science');
      expect(body.publisher).toBe('National Academies Press');
      expect(body.isbn).toBe('9780306406157');
    });

    it('found lookup trims whitespace from provider-supplied title/author/publisher', async () => {
      stubFoundResponse({
        'ISBN:9780306406157': {
          title: '  On Being a Scientist  ',
          authors: [{ name: '  Committee on Science  ' }],
          publishers: [{ name: '  National Academies Press  ' }],
        },
      });

      const res = await POST(
        postRequest({
          category: 'book',
          isbn: '9780306406157',
          condition: 'Good',
          acquisition_cost: 1000,
          acquisition_date: '2024-01-01',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('On Being a Scientist');
      expect(body.author).toBe('Committee on Science');
      expect(body.publisher).toBe('National Academies Press');
    });

    it('whitespace-only publisher falls back to the ISBN lookup publisher instead of being treated as provided', async () => {
      stubFoundResponse({
        'ISBN:9780306406157': {
          title: 'Ignored (body already has a title)',
          authors: [{ name: 'Ignored (body already has an author)' }],
          publishers: [{ name: 'Lookup Publisher' }],
        },
      });

      const res = await POST(postRequest(validBook({ isbn: '9780306406157', publisher: '   ' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.publisher).toBe('Lookup Publisher');
    });

    it('a non-uniqueness DB error while inserting a book is a 500, not mistaken for a duplicate ISBN', async () => {
      stubFoundResponse({}); // lookup result is irrelevant

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO book_details')) {
          throw new Error('disk full'); // no .code — not a constraint violation
        }
        return realPrepare(sql);
      });

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error.');

      prepareSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('whitespace-only author falls back to the ISBN lookup author instead of failing validation', async () => {
      stubFoundResponse({
        'ISBN:9780306406157': {
          title: 'Ignored (body already has a title)',
          authors: [{ name: 'Committee on Science' }],
          publishers: [{ name: 'Publisher X' }],
        },
      });

      const res = await POST(postRequest(validBook({ isbn: '9780306406157', author: '   ' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.author).toBe('Committee on Science');
    });

    it('isbn explicitly null is treated the same as omitted (no lookup performed)', async () => {
      const res = await POST(postRequest(validBook({ isbn: null })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isbn).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('isbn explicitly empty string is treated the same as omitted (no lookup performed)', async () => {
      const res = await POST(postRequest(validBook({ isbn: '' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isbn).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('duplicate ISBN race (pre-check misses it) is still caught by the UNIQUE constraint → 409', async () => {
      insertBookItem({ isbn: '9780306406157' });
      stubFoundResponse({}); // lookup result is irrelevant to the duplicate check

      const realPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT item_id FROM book_details WHERE isbn')) {
          return { get: () => undefined } as unknown as ReturnType<typeof db.prepare>;
        }
        return realPrepare(sql);
      });

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('ISBN already exists.');

      prepareSpy.mockRestore();
    });

    it('not-found lookup does not block creation when title/author supplied manually (FR3/AC11)', async () => {
      stubFoundResponse({}); // no matching key → not-found

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe('The Great Gatsby');
      expect(body.isbn).toBe('9780306406157');
    });

    it('provider unavailable (network error) does not block creation (AC11)', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network down'));

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isbn).toBe('9780306406157');
    });

    it('duplicate ISBN (already in book_details) → 409 "ISBN already exists."', async () => {
      insertBookItem({ isbn: '9780306406157' });
      stubFoundResponse({}); // lookup result is irrelevant to the duplicate check

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('ISBN already exists.');
    });

    it('omitting isbn entirely never calls lookupISBN / fetch', async () => {
      const res = await POST(postRequest(validBook()));
      expect(res.status).toBe(201);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/items
// ---------------------------------------------------------------------------

describe('GET /api/items', () => {
  beforeEach(cleanTables);

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

  it('free-text search is multi-term: "great gatsby" matches a title containing both words', async () => {
    insertBookItem({ title: 'The Great Gatsby' });
    insertBookItem({ title: 'Moby Dick' });

    const res = await GET(getRequest('?q=great%20gatsby'));
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe('The Great Gatsby');
  });

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

  it('platforms are aggregated into a CSV-derived array', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 999 });
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'eBay');
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(uuidv4(), id, 'AbeBooks');

    const res = await GET(getRequest());
    const body = await res.json();
    expect(body.items[0].platforms.sort()).toEqual(['AbeBooks', 'eBay']);
  });
});
