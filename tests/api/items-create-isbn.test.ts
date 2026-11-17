import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/items/route';
import db from '@/lib/db';
import {
  postRequest,
  validBook,
  insertBookItem,
  resetItemsAndTenant,
} from '../fixtures/itemsApi';

const setupISBNLookupPathFetch = () => {
  vi.stubGlobal('fetch', vi.fn());
};

const teardownISBNLookupPathFetch = () => {
  vi.unstubAllGlobals();
};

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

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

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

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

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

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

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

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

    it('isbn explicitly null is treated the same as omitted (no lookup performed)', async () => {
      const res = await POST(postRequest(validBook({ isbn: null })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isbn).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

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
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

    it('provider unavailable (network error) does not block creation (AC11)', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network down'));

      const res = await POST(postRequest(validBook({ isbn: '9780306406157' })));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isbn).toBe('9780306406157');
    });
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  describe('ISBN lookup path (fetch mocked — never hits the real network)', () => {
    beforeEach(setupISBNLookupPathFetch);
    afterEach(teardownISBNLookupPathFetch);

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
