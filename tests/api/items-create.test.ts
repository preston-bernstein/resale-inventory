import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/items/route';
import db from '@/lib/db';
import { insertBookItem, postRequest, validBook, validClothing, validElectronics, useFreshTenant } from './itemFixtures';

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

function setupISBNLookupPathFetch() {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

describe('POST /api/items › creating items', () => {
  useFreshTenant();

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

  it('creates an electronics item successfully → 201, flat row shape, status Unlisted', async () => {
    const res = await POST(postRequest(validElectronics()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.category).toBe('electronics');
    expect(body.title).toBe('Apple MacBook Pro');
    expect(body.brand).toBe('Apple');
    expect(body.model).toBe('MacBook Pro');
    expect(body.condition).toBe('Excellent');
    expect(body.status).toBe('Unlisted');
  });
});

describe('POST /api/items › bad requests', () => {
  useFreshTenant();

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
});

describe('POST /api/items › title and author', () => {
  useFreshTenant();

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
});

describe('POST /api/items › author and publisher', () => {
  useFreshTenant();

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
});

describe('POST /api/items › acquisition cost', () => {
  useFreshTenant();

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
});

describe('POST /api/items › acquisition date and condition', () => {
  useFreshTenant();

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
});

describe('POST /api/items › ISBN format', () => {
  useFreshTenant();

  it('invalid ISBN format → 422 "Invalid ISBN format."', async () => {
    const res = await POST(postRequest(validBook({ isbn: 'not-an-isbn' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Invalid ISBN format.');
  });
});

describe('POST /api/items › ISBN lookup defaults (1 of 3)', () => {
  useFreshTenant();

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    setupISBNLookupPathFetch();

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
  });
});

describe('POST /api/items › ISBN lookup defaults (2 of 3)', () => {
  useFreshTenant();

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    setupISBNLookupPathFetch();

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
  });
});

describe('POST /api/items › ISBN lookup defaults (3 of 3)', () => {
  useFreshTenant();

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    setupISBNLookupPathFetch();

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
  });
});

describe('POST /api/items › ISBN omitted', () => {
  useFreshTenant();

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    setupISBNLookupPathFetch();

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
  });
});

describe('POST /api/items › ISBN lookup failures', () => {
  useFreshTenant();

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    setupISBNLookupPathFetch();

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
