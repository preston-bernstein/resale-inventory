import { describe, it, expect } from 'vitest';
import db from '@/lib/db';
import { bookRow, clothingRow, csvFile, postImport, toCsv, useFreshImportTenant } from './importFixtures';

describe('POST /api/import › status and category', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › required fields', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › conditions', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › cost and date fields', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › ISBN checks', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › ISBN reuse and ISBN-10', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › weight', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › measurements', () => {
  useFreshImportTenant();

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
});
