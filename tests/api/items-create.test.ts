import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/items/route';
import db from '@/lib/db';
import {
  postRequest,
  validBook,
  validClothing,
  validElectronics,
  resetItemsAndTenant,
} from '../fixtures/itemsApi';

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

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

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('invalid JSON body → 400', async () => {
    const res = await POST(postRequest('{not valid json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON body.');
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

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
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

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
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

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
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

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
});
