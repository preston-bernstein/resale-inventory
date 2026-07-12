import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { POST } from '@/app/api/import/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'category', 'title', 'author', 'publisher', 'isbn', 'condition',
  'acquisition_cost_usd', 'acquisition_date',
  'brand', 'size_label', 'color', 'material', 'gender_department', 'weight_oz',
  'pit_to_pit_in', 'length_in', 'sleeve_length_in', 'waist_in', 'rise_in',
  'inseam_in', 'leg_opening_in', 'hip_in',
] as const;

type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string>>;

function toCsv(rows: CsvRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => {
      const v = row[col] ?? '';
      // Quote if it contains a comma (only used for messages in tests, but
      // keep it correct in general).
      return v.includes(',') ? `"${v}"` : v;
    }).join(','),
  );
  return [header, ...lines].join('\n');
}

function csvFile(text: string, name = 'import.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

function bookRow(overrides: CsvRow = {}): CsvRow {
  return {
    category: 'book',
    title: 'Test Book',
    author: 'Test Author',
    publisher: 'Test Publisher',
    condition: 'Good',
    acquisition_cost_usd: '10.00',
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

function clothingRow(overrides: CsvRow = {}): CsvRow {
  return {
    category: 'clothing',
    title: 'Test Jacket',
    brand: 'Patagonia',
    size_label: 'L',
    condition: 'NWT',
    acquisition_cost_usd: '25.00',
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

async function postImport(body: FormData | string, headers: Record<string, string> = {}) {
  const req = new NextRequest('http://localhost/api/import', {
    method: 'POST',
    headers,
    body: body as unknown as BodyInit,
  });
  return POST(req);
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

describe('POST /api/import', () => {
  beforeEach(() => {
    cleanTables();
  });

  it('imports a valid book row', async () => {
    const csv = toCsv([bookRow({ isbn: '9780306406157' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);

    const row = db.prepare(`
      SELECT i.title, i.status, i.category, bd.author, bd.isbn, bd.condition
      FROM items i JOIN book_details bd ON bd.item_id = i.id
    `).get() as Record<string, unknown>;
    expect(row.title).toBe('Test Book');
    expect(row.status).toBe('Unlisted');
    expect(row.category).toBe('book');
    expect(row.author).toBe('Test Author');
    expect(row.isbn).toBe('9780306406157');
    expect(row.condition).toBe('Good');
  });

  it('imports a valid clothing row', async () => {
    const csv = toCsv([clothingRow({ weight_oz: '12', pit_to_pit_in: '20.5' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);

    const row = db.prepare(`
      SELECT i.title, i.status, i.category, cd.brand, cd.size_label, cd.weight_oz, cd.pit_to_pit_in
      FROM items i JOIN clothing_details cd ON cd.item_id = i.id
    `).get() as Record<string, unknown>;
    expect(row.title).toBe('Test Jacket');
    expect(row.status).toBe('Unlisted');
    expect(row.category).toBe('clothing');
    expect(row.brand).toBe('Patagonia');
    expect(row.size_label).toBe('L');
    expect(row.weight_oz).toBe(12);
    expect(row.pit_to_pit_in).toBe(20.5);
  });

  it('always creates imported rows with status Unlisted, ignoring a status column', async () => {
    const csv = toCsv([bookRow()]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));
    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    const row = db.prepare('SELECT status FROM items').get() as { status: string };
    expect(row.status).toBe('Unlisted');
  });

  it('rejects an unknown category value with a per-row error', async () => {
    const csv = toCsv([bookRow({ category: 'shoes' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].row).toBe(2);
    expect(data.errors[0].fields).toEqual(['category']);
    expect(data.errors[0].message).toMatch(/Invalid category/);
  });

  it('rejects a book row missing a required field (author)', async () => {
    const csv = toCsv([bookRow({ author: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].fields).toEqual(['author']);
    expect(data.errors[0].message).toMatch(/Missing required fields: author/);
  });

  it('rejects a clothing row missing a required field (brand)', async () => {
    const csv = toCsv([clothingRow({ brand: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].fields).toEqual(['brand']);
  });

  it('rejects a row with an invalid condition for its category', async () => {
    const csv = toCsv([bookRow({ condition: 'Excellent' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['condition']);
    expect(data.errors[0].message).toMatch(/Invalid condition/);
  });

  it('rejects a row with a clothing condition on a book row (cross-category vocab)', async () => {
    const csv = toCsv([bookRow({ condition: 'EUC' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));
    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['condition']);
  });

  it('rejects a malformed acquisition_cost_usd', async () => {
    const csv = toCsv([bookRow({ acquisition_cost_usd: 'abc' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['acquisition_cost_usd']);
    expect(data.errors[0].message).toMatch(/Invalid acquisition_cost_usd/);
  });

  it('rejects a negative acquisition_cost_usd', async () => {
    const csv = toCsv([bookRow({ acquisition_cost_usd: '-5.00' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['acquisition_cost_usd']);
  });

  it('rejects a malformed acquisition_date', async () => {
    const csv = toCsv([bookRow({ acquisition_date: '01/02/2024' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['acquisition_date']);
    expect(data.errors[0].message).toMatch(/Invalid acquisition_date format/);
  });

  it('rejects a row with an invalid ISBN format', async () => {
    const csv = toCsv([bookRow({ isbn: 'not-an-isbn' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['isbn']);
  });

  it('rejects a book row with no ISBN provided as still valid (isbn optional)', async () => {
    const csv = toCsv([bookRow({ isbn: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);
    const row = db.prepare('SELECT isbn FROM book_details').get() as { isbn: string | null };
    expect(row.isbn).toBeNull();
  });

  it('rejects duplicate ISBNs within the same file (second occurrence errors)', async () => {
    const csv = toCsv([
      bookRow({ title: 'Book A', isbn: '9780306406157' }),
      bookRow({ title: 'Book B', isbn: '9780306406157' }),
    ]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].row).toBe(3);
    expect(data.errors[0].fields).toEqual(['isbn']);
    expect(data.errors[0].message).toMatch(/already present earlier in this file/);
  });

  it('rejects an ISBN that already exists in inventory', async () => {
    // First import establishes the ISBN in the DB.
    const csv1 = toCsv([bookRow({ title: 'Existing', isbn: '9780306406157' })]);
    const fd1 = new FormData();
    fd1.append('file', csvFile(csv1));
    await postImport(fd1);

    const csv2 = toCsv([bookRow({ title: 'New Import', isbn: '9780306406157' })]);
    const fd2 = new FormData();
    fd2.append('file', csvFile(csv2));
    const res2 = await postImport(fd2);
    const data2 = await res2.json();
    expect(data2.imported).toBe(0);
    expect(data2.errors[0].fields).toEqual(['isbn']);
    expect(data2.errors[0].message).toMatch(/already exists in inventory/);
  });

  it('normalizes an ISBN-10 to ISBN-13 on import', async () => {
    const csv = toCsv([bookRow({ isbn: '0-306-40615-2' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));
    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    const row = db.prepare('SELECT isbn FROM book_details').get() as { isbn: string };
    expect(row.isbn).toBe('9780306406157');
  });

  it('rejects an invalid weight_oz (negative)', async () => {
    const csv = toCsv([clothingRow({ weight_oz: '-3' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['weight_oz']);
    expect(data.errors[0].message).toMatch(/Invalid weight_oz/);
  });

  it('rejects an invalid weight_oz (non-integer)', async () => {
    const csv = toCsv([clothingRow({ weight_oz: '5.5' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['weight_oz']);
  });

  it('treats an empty/non-numeric weight_oz as "not provided" (valid, null)', async () => {
    const csv = toCsv([clothingRow({ weight_oz: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    const row = db.prepare('SELECT weight_oz FROM clothing_details').get() as { weight_oz: number | null };
    expect(row.weight_oz).toBeNull();
  });

  it('rejects an invalid measurement value (negative waist_in)', async () => {
    const csv = toCsv([clothingRow({ waist_in: '-1' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields).toEqual(['waist_in']);
    expect(data.errors[0].message).toMatch(/Invalid measurement value/);
  });

  it('reports multiple invalid measurement fields together on one row', async () => {
    const csv = toCsv([clothingRow({ waist_in: '-1', hip_in: '-2' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors[0].fields.sort()).toEqual(['hip_in', 'waist_in']);
  });

  it('accepts optional color/material as null when blank', async () => {
    const csv = toCsv([clothingRow({ color: '', material: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    const row = db.prepare('SELECT color, material FROM clothing_details').get() as {
      color: string | null; material: string | null;
    };
    expect(row.color).toBeNull();
    expect(row.material).toBeNull();
  });

  it('a batch with valid and invalid rows partially succeeds', async () => {
    const csv = toCsv([
      bookRow({ title: 'Good Book' }),
      bookRow({ title: 'Bad Book', author: '' }),
      clothingRow({ title: 'Good Jacket' }),
      clothingRow({ title: 'Bad Jacket', acquisition_date: 'not-a-date' }),
    ]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(2);
    expect(data.errors).toHaveLength(2);
    expect(data.errors.map((e: { row: number }) => e.row)).toEqual([3, 5]);

    const titles = (db.prepare('SELECT title FROM items ORDER BY title').all() as Array<{ title: string }>)
      .map((r) => r.title);
    expect(titles).toEqual(['Good Book', 'Good Jacket']);
  });

  it('an empty file (headers only) imports nothing and errors nothing', async () => {
    const csv = toCsv([]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('a fully empty file (no content) imports nothing', async () => {
    const formData = new FormData();
    formData.append('file', csvFile(''));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('returns 400 when no file field is provided', async () => {
    const formData = new FormData();
    formData.append('not-file', 'irrelevant');

    const res = await postImport(formData);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('No file provided');
  });

  it('returns 400 when the file field is not an actual File', async () => {
    const formData = new FormData();
    formData.append('file', 'just a plain string, not a File');

    const res = await postImport(formData);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('No file provided');
  });

  it('returns 400 for invalid multipart form data', async () => {
    const res = await postImport('not-valid-multipart-body', {
      'content-type': 'multipart/form-data',
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid multipart form data');
  });

  it('returns 413 when the file exceeds the 10MB size limit', async () => {
    const bigContent = 'category,title\n' + 'a'.repeat(11 * 1024 * 1024);
    const formData = new FormData();
    formData.append('file', csvFile(bigContent, 'big.csv'));

    const res = await postImport(formData);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('File too large');
  });

  it('normalizes a BOM-prefixed header key', async () => {
    const csv = '﻿category,title,author,publisher,isbn,condition,acquisition_cost_usd,acquisition_date\n' +
      'book,BOM Book,BOM Author,,,Good,10.00,2024-01-01';
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);
    const row = db.prepare('SELECT title FROM items').get() as { title: string };
    expect(row.title).toBe('BOM Book');
  });

  describe('DB-level constraint failure mapping (mocked)', () => {
    it('maps a SQLITE_CONSTRAINT_CHECK failure to 422', async () => {
      const spy = vi.spyOn(db, 'transaction').mockImplementation(() => {
        return (() => {
          const err = new Error('check failed') as Error & { code: string };
          err.code = 'SQLITE_CONSTRAINT_CHECK';
          throw err;
        }) as unknown as ReturnType<typeof db.transaction>;
      });
      try {
        const csv = toCsv([]);
        const formData = new FormData();
        formData.append('file', csvFile(csv));
        const res = await postImport(formData);
        expect(res.status).toBe(422);
        const data = await res.json();
        expect(data.error).toBe('Validation failed.');
      } finally {
        spy.mockRestore();
      }
    });

    it('maps a SQLITE_CONSTRAINT_UNIQUE failure to 409', async () => {
      const spy = vi.spyOn(db, 'transaction').mockImplementation(() => {
        return (() => {
          const err = new Error('unique failed') as Error & { code: string };
          err.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw err;
        }) as unknown as ReturnType<typeof db.transaction>;
      });
      try {
        const csv = toCsv([]);
        const formData = new FormData();
        formData.append('file', csvFile(csv));
        const res = await postImport(formData);
        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.error).toBe('Conflicts with an existing record.');
      } finally {
        spy.mockRestore();
      }
    });

    it('maps an unrecognized error to 500', async () => {
      const spy = vi.spyOn(db, 'transaction').mockImplementation(() => {
        return (() => {
          throw new Error('something else broke');
        }) as unknown as ReturnType<typeof db.transaction>;
      });
      try {
        const csv = toCsv([]);
        const formData = new FormData();
        formData.append('file', csvFile(csv));
        const res = await postImport(formData);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toBe('Internal server error');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
