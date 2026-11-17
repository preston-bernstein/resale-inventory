import { describe, it, expect, vi } from 'vitest';
import db from '@/lib/db';
import { bookRow, clothingRow, csvFile, postImport, toCsv, useFreshImportTenant } from './importFixtures';

describe('POST /api/import › batches and empty files', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › form errors', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › BOM headers', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › database errors (1 of 2)', () => {
  useFreshImportTenant();

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
  });
});

describe('POST /api/import › database errors (2 of 2)', () => {
  useFreshImportTenant();

  describe('DB-level constraint failure mapping (mocked)', () => {
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
