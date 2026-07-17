import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/isbn/[isbn]/route';
import { POST } from '@/app/api/items/route';
import * as isbnLib from '@/lib/isbn';
import { createTestTenant } from '../helpers/tenant';

// The route is a thin wrapper around lib/isbn.ts's lookupISBN(), which does a
// real outbound fetch to Open Library. We stub global fetch so these tests
// never depend on network availability.

// Task 21 retrofit (finished by Task 22): this route now requires a tenant
// session cookie. A fresh tenant is created per test (see beforeEach below).
let currentTenant: ReturnType<typeof createTestTenant>;

function params(isbn: string) {
  return { params: Promise.resolve({ isbn }) };
}

function isbnReq(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/isbn/${path}`, {
    headers: { Cookie: currentTenant.cookieHeader },
  });
}

function openLibraryResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
  });
}

describe('GET /api/isbn/[isbn]', () => {
  beforeEach(() => {
    currentTenant = createTestTenant();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 400 for a malformed ISBN (too short)', async () => {
    const res = await GET(isbnReq('123'), params('123'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid ISBN format.');
  });

  it('returns 400 for a malformed ISBN (letters in a 13-digit slot)', async () => {
    const res = await GET(isbnReq('abcdefghijklm'), params('abcdefghijklm'));
    expect(res.status).toBe(400);
  });

  it('does not call lookupISBN when the format check fails', async () => {
    const spy = vi.spyOn(isbnLib, 'lookupISBN');
    const res = await GET(isbnReq('123'), params('123'));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects a 2-character string (regex must require the full 10/13-char length, not just 1 digit)', async () => {
    const res = await GET(isbnReq('5X'), params('5X'));
    expect(res.status).toBe(400);
  });

  // The following four tests use inputs the ROUTE's own ISBN_PATTERN must
  // reject on its own terms. They assert on `lookupISBN` never being called
  // rather than just on the final status/body: because lib/isbn.ts applies
  // the *same* pattern again internally, a route-level regex mutant that
  // wrongly treats one of these strings as valid still produces an identical
  // 400 response (lib's own check catches it) — so only a call-count
  // assertion on the route's pre-check actually observes the mutation.
  it('rejects a valid ISBN-10 body followed by a trailing character (regex must anchor at the end)', async () => {
    const spy = vi.spyOn(isbnLib, 'lookupISBN');
    const res = await GET(isbnReq('0306406152X'), params('0306406152X'));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects a valid ISBN-10 suffix preceded by non-digit characters (regex must anchor at the start)', async () => {
    const spy = vi.spyOn(isbnLib, 'lookupISBN');
    const res = await GET(isbnReq('ZZ0306406152'), params('ZZ0306406152'));
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects a valid 13-digit suffix preceded by non-digit characters', async () => {
    const spy = vi.spyOn(isbnLib, 'lookupISBN');
    const res = await GET(
      isbnReq('ZZ9780593099322'),
      params('ZZ9780593099322'),
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejects 13 digits followed by trailing garbage (regex must anchor at the end)', async () => {
    const spy = vi.spyOn(isbnLib, 'lookupISBN');
    const res = await GET(
      isbnReq('9780593099322X'),
      params('9780593099322X'),
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('accepts a bare 10-digit ISBN-10 ending in a digit and proceeds to lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await GET(isbnReq('0306406152'), params('0306406152'));
    expect(res.status).toBe(404); // valid format → reaches the provider, which has no record
  });

  it('accepts a bare 10-digit ISBN-10 ending in X and proceeds to lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await GET(isbnReq('019853453X'), params('019853453X'));
    expect(res.status).toBe(404);
  });

  it('strips hyphens/spaces before validating format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openLibraryResponse({
        'ISBN:9780306406157': {
          title: 'Zen and the Art of Motorcycle Maintenance',
          authors: [{ name: 'Robert M. Pirsig' }],
          publishers: [{ name: 'Morrow' }],
        },
      }),
    ));
    const res = await GET(
      isbnReq('978-0-306-40615-7'),
      params('978-0-306-40615-7'),
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 with title/author/publisher on a found ISBN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openLibraryResponse({
        'ISBN:9780593099322': {
          title: 'Project Hail Mary',
          authors: [{ name: 'Andy Weir' }],
          publishers: [{ name: 'Ballantine' }],
        },
      }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      publisher: 'Ballantine',
    });
  });

  it('returns 404 when the provider has no record for the ISBN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Not found');
  });

  it('returns 404 when the record has neither title nor author (treated as not found)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openLibraryResponse({ 'ISBN:9780593099322': {} }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toEqual({ error: 'Not found' });
  });

  it('returns 200 (not 404) when title is empty but author is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openLibraryResponse({
        'ISBN:9780593099322': { authors: [{ name: 'Some Author' }] },
      }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ title: '', author: 'Some Author', publisher: '' });
  });

  it('returns 503 when the provider is unreachable (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe('Lookup unavailable. Enter details manually.');
  });

  it('returns 503 when the provider responds with a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { status: 500 }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe('Lookup unavailable. Enter details manually.');
  });

  it('returns 503 when the provider body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not json', { status: 200 }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(503);
  });

  it('fills in empty string fields when authors/publishers are missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openLibraryResponse({
        'ISBN:9780593099322': { title: 'Untitled Work' },
      }),
    ));
    const res = await GET(isbnReq('9780593099322'), params('9780593099322'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ title: 'Untitled Work', author: '', publisher: '' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/items — ISBN checksum validation (book branch)
// ---------------------------------------------------------------------------

describe('POST /api/items — ISBN checksum validation (book branch)', () => {
  beforeEach(() => {
    currentTenant = createTestTenant();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function postReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/items', {
      method: 'POST',
      headers: { Cookie: currentTenant.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function minimalBookBody(isbn?: string): Record<string, unknown> {
    const base = {
      category: 'book',
      title: 'Test Book',
      author: 'Test Author',
      condition: 'Good',
      acquisition_cost: 500,
      acquisition_date: '2026-01-01',
    };
    if (isbn !== undefined) {
      return { ...base, isbn };
    }
    return base;
  }

  it('accepts valid ISBN-10 with correct checksum and proceeds to lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await POST(postReq(minimalBookBody('0306406152')));
    expect(res.status).not.toBe(422); // not a checksum-422
    // may be 201 (created), 404 (not found), or 409 (duplicate) from DB
    expect([201, 404, 409, 200]).toContain(res.status);
  });

  it('accepts valid ISBN-10 ending in X with correct checksum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await POST(postReq(minimalBookBody('043942089X')));
    expect(res.status).not.toBe(422); // not a checksum-422
    expect([201, 404, 409, 200]).toContain(res.status);
  });

  it('accepts valid ISBN-13 with correct checksum', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openLibraryResponse({})));
    const res = await POST(postReq(minimalBookBody('9780439420891')));
    expect(res.status).not.toBe(422); // not a checksum-422
    expect([201, 404, 409, 200]).toContain(res.status);
  });

  it('rejects invalid-checksum ISBN-10 with 422 checksum error', async () => {
    const res = await POST(postReq(minimalBookBody('0306406156')));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('ISBN checksum invalid.');
    expect(data.fields).toEqual(['isbn']);
  });

  it('rejects invalid-checksum ISBN-13 with 422 checksum error', async () => {
    const res = await POST(postReq(minimalBookBody('9780306406158')));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('ISBN checksum invalid.');
    expect(data.fields).toEqual(['isbn']);
  });

  it('distinguishes checksum error from shape error (shape-invalid ISBN)', async () => {
    const res = await POST(postReq(minimalBookBody('123')));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('Invalid ISBN format.');
    expect(data.fields).toBeUndefined(); // shape error has no fields array
  });

  it('does not fail on blank/omitted ISBN (optional ISBN path)', async () => {
    vi.stubGlobal('fetch', vi.fn()); // should not be called for blank ISBN
    const res = await POST(postReq(minimalBookBody()));
    // should succeed (201) or fail for other reasons (missing author in this case),
    // but NOT with a checksum-related 422
    const data = await res.json();
    if (res.status === 422) {
      // some other validation might fail, but checksum must not be the reason
      expect(data.error).not.toBe('ISBN checksum invalid.');
    }
  });

  it('skips ISBN lookup when checksum is invalid (fetch never called)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const res = await POST(postReq(minimalBookBody('0306406156')));
    expect(res.status).toBe(422);
    // fetch should never have been called because checksum failed first
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
