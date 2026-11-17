import { describe, it, expect } from 'vitest';
import db from '@/lib/db';
import { bookRow, clothingRow, csvFile, electronicsRow, postImport, toCsv, useFreshImportTenant } from './importFixtures';

describe('POST /api/import › valid rows (1 of 3)', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › valid rows (2 of 3)', () => {
  useFreshImportTenant();

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
});

describe('POST /api/import › valid rows (3 of 3)', () => {
  useFreshImportTenant();

  it('imports a valid electronics row', async () => {
    const csv = toCsv([electronicsRow({ processor: 'M2', ram_gb: '16', storage_gb: '512' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);

    const row = db.prepare(`
      SELECT i.title, i.status, i.category, ed.brand, ed.model, ed.processor, ed.ram_gb, ed.storage_gb, ed.condition
      FROM items i JOIN electronics_details ed ON ed.item_id = i.id
    `).get() as Record<string, unknown>;
    expect(row.title).toBe('Apple MacBook Pro');
    expect(row.status).toBe('Unlisted');
    expect(row.category).toBe('electronics');
    expect(row.brand).toBe('Apple');
    expect(row.model).toBe('MacBook Pro');
    expect(row.processor).toBe('M2');
    expect(row.ram_gb).toBe(16);
    expect(row.storage_gb).toBe(512);
    expect(row.condition).toBe('Excellent');
  });
});

describe('POST /api/import › electronics rows (1 of 2)', () => {
  useFreshImportTenant();

  it('trims whitespace from an electronics row\'s brand/model/processor', async () => {
    const csv = toCsv([electronicsRow({ brand: '  Apple  ', model: '  MacBook Pro  ', processor: '  M2  ' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    const row = db.prepare(`
      SELECT ed.brand, ed.model, ed.processor, i.title FROM electronics_details ed JOIN items i ON i.id = ed.item_id
    `).get() as Record<string, unknown>;
    expect(row.brand).toBe('Apple');
    expect(row.model).toBe('MacBook Pro');
    expect(row.processor).toBe('M2');
    expect(row.title).toBe('Apple MacBook Pro');
  });

  it('treats a CSV with no processor column at all as null (never crashes on missing optional chaining)', async () => {
    const csv = 'category,brand,model,condition,acquisition_cost_usd,acquisition_date\n' +
      'electronics,Apple,MacBook Pro,Excellent,450.00,2024-01-01';
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);
    const row = db.prepare('SELECT processor FROM electronics_details').get() as { processor: unknown };
    expect(row.processor).toBeNull();
  });
});

describe('POST /api/import › electronics rows (2 of 2)', () => {
  useFreshImportTenant();

  it('reports the exact invalid-field message for a rejected electronics numeric field', async () => {
    const csv = toCsv([electronicsRow({ ram_gb: '-1' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.errors[0].message).toBe('Invalid value(s): ram_gb.');
  });

  it('rejects an electronics row missing a required field (model)', async () => {
    const csv = toCsv([electronicsRow({ model: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].fields).toContain('model');
  });
});

describe('POST /api/import › electronics numeric fields', () => {
  useFreshImportTenant();

  it('rejects an electronics row with an invalid numeric field (negative ram_gb)', async () => {
    const csv = toCsv([electronicsRow({ ram_gb: '-1' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].fields).toContain('ram_gb');
  });

  it('rejects an electronics row with a battery_health_pct outside 0-100', async () => {
    const csv = toCsv([electronicsRow({ battery_health_pct: '101' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(0);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].fields).toContain('battery_health_pct');
  });

  it('treats an empty/non-numeric electronics numeric field as "not provided" (valid, null)', async () => {
    const csv = toCsv([electronicsRow({ ram_gb: '', battery_cycle_count: '' })]);
    const formData = new FormData();
    formData.append('file', csvFile(csv));

    const res = await postImport(formData);
    const data = await res.json();
    expect(data.imported).toBe(1);
    expect(data.errors).toEqual([]);
    const row = db.prepare(`
      SELECT ed.ram_gb, ed.battery_cycle_count FROM electronics_details ed
    `).get() as Record<string, unknown>;
    expect(row.ram_gb).toBeNull();
    expect(row.battery_cycle_count).toBeNull();
  });
});
