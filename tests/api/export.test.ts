import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import Papa from 'papaparse';
import db from '@/lib/db';
import { GET } from '@/app/api/export/route';
import { createTestTenant } from '../fixtures/tenant';
import { seedBookItem, seedClothingItem, seedElectronicsItem } from '../fixtures/items';

// ---------------------------------------------------------------------------
// Helpers — mirrors tests/fixtures/items.ts's insert helpers so rows land
// in items + the correct satellite table exactly like the real API would
// create them.
//
// Task 19/20 retrofit (finished by Task 22): this route now requires a
// tenant session cookie. A fresh tenant is created per test (see beforeEach
// below) and stashed here so the insert helpers and exportRequest() can pick
// it up without every call site needing to be touched individually.
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

function exportRequest(): NextRequest {
  return new NextRequest('http://localhost/api/export', {
    headers: { Cookie: currentTenant.cookieHeader },
  });
}

function insertBookItem(overrides: Record<string, unknown> = {}): string {
  return seedBookItem(currentTenant.tenantId, { title: 'Test Book', author: 'Test Author', publisher: 'Test Publisher', ...overrides });
}

function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  return seedClothingItem(currentTenant.tenantId, { title: 'Test Clothing Item', brand: 'TestBrand', ...overrides });
}

function insertElectronicsItem(overrides: Record<string, unknown> = {}): string {
  return seedElectronicsItem(currentTenant.tenantId, { title: 'Test Laptop', ...overrides });
}

function addPlatform(itemId: string, platform: string) {
  db.prepare(
    `INSERT INTO item_platforms (id, item_id, platform, listed_at, tenant_id) VALUES (?, ?, ?, datetime('now'), ?)`,
  ).run(uuidv4(), itemId, platform, currentTenant.tenantId);
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM electronics_details; DELETE FROM items;',
  );
}

const CLOTHING_ONLY_COLUMNS = [
  'brand', 'size_label', 'color', 'weight_oz', 'material', 'pit_to_pit_in', 'length_in',
  'sleeve_length_in', 'waist_in', 'rise_in', 'inseam_in', 'leg_opening_in', 'hip_in',
];

function expectBlank(row: Record<string, string>, columns: string[]) {
  expectFields(row, Object.fromEntries(columns.map((column) => [column, ''])));
}

async function exportedRows() {
  const res = await GET(exportRequest());
  const text = await res.text();
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
}

async function exportedRow(id: string) {
  return (await exportedRows()).find((r) => r.id === id)!;
}

function expectFields(row: Record<string, string>, expected: Record<string, string>) {
  for (const [column, value] of Object.entries(expected)) {
    expect(row[column], column).toBe(value);
  }
}

const setupGETApiExport = () => {
  cleanTables();
  currentTenant = createTestTenant();
};

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('returns 200 with text/csv content-type and dated attachment filename', async () => {
    const res = await GET(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="inventory-${today}.csv"`,
    );
  });

  it('with no items, emits only the header row', async () => {
    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    expect(parsed.data).toHaveLength(0);
    expect(parsed.meta.fields).toEqual([
      'id', 'category', 'title', 'isbn', 'author', 'publisher',
      'brand', 'size_label', 'color', 'material', 'gender_department',
      'weight_oz', 'pit_to_pit_in', 'length_in', 'sleeve_length_in',
      'waist_in', 'rise_in', 'inseam_in', 'leg_opening_in', 'hip_in',
      'model', 'processor', 'ram_gb', 'storage_gb', 'screen_size_in',
      'battery_health_pct', 'battery_cycle_count',
      'condition', 'acquisition_cost_usd', 'acquisition_date', 'status',
      'listing_price_usd', 'platforms', 'sale_price_usd', 'sale_platform',
      'sale_date', 'gross_profit_usd', 'created_at', 'updated_at',
    ]);
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('exports a book row with book fields populated and clothing fields blank', async () => {
    const id = insertBookItem({
      title: 'Dune',
      author: 'Frank Herbert',
      publisher: 'Chilton',
      isbn: '9780593099322',
      condition: 'Very Good',
      acquisition_cost: 550,
    });

    const row = await exportedRow(id);

    expect(row).toBeTruthy();
    expectFields(row, {
      category: 'book',
      title: 'Dune',
      author: 'Frank Herbert',
      publisher: 'Chilton',
      isbn: '9780593099322',
      condition: 'Very Good',
      acquisition_cost_usd: '5.50',
      status: 'Unlisted',
    });
    // clothing-only columns must be blank on a book row
    expectBlank(row, CLOTHING_ONLY_COLUMNS);
    // sale fields blank on an unsold item
    expect(row.sale_platform).toBe('');
    expect(row.sale_date).toBe('');
    // exact acquisition_date and non-blank timestamps
    expect(row.acquisition_date).toBe('2024-01-01');
    expect(row.created_at).not.toBe('');
    expect(row.updated_at).not.toBe('');
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('exports a book row with nullable isbn/publisher left blank', async () => {
    const id = insertBookItem({ isbn: null, publisher: null });

    const row = await exportedRow(id);

    expect(row.isbn).toBe('');
    expect(row.publisher).toBe('');
  });
});

const FLEECE_JACKET = {
  title: 'Fleece Jacket',
  brand: 'Patagonia',
  size_label: 'L',
  color: 'Green',
  material: 'Fleece',
  gender_department: 'Mens',
  weight_oz: 18,
  pit_to_pit_in: 22.5,
  length_in: 30,
  sleeve_length_in: 24.5,
  waist_in: 32,
  rise_in: 11.5,
  inseam_in: 30,
  leg_opening_in: 7.25,
  hip_in: 42,
  condition: 'NWT',
  acquisition_cost: 4200,
};

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('exports a clothing row with clothing fields populated and book fields blank', async () => {
    const id = insertClothingItem(FLEECE_JACKET);

    const row = await exportedRow(id);

    expectFields(row, {
      category: 'clothing',
      brand: 'Patagonia',
      size_label: 'L',
      color: 'Green',
      material: 'Fleece',
      gender_department: 'Mens',
      weight_oz: '18',
      pit_to_pit_in: '22.5',
      length_in: '30',
      sleeve_length_in: '24.5',
      waist_in: '32',
      rise_in: '11.5',
      inseam_in: '30',
      leg_opening_in: '7.25',
      hip_in: '42',
      condition: 'NWT',
      acquisition_cost_usd: '42.00',
    });
    // book-only columns must be blank on a clothing row
    expect(row.isbn).toBe('');
    expect(row.author).toBe('');
    expect(row.publisher).toBe('');
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('exports an electronics row with electronics fields populated and book/clothing fields blank', async () => {
    const id = insertElectronicsItem({
      title: 'MacBook Pro 14"',
      brand: 'Apple',
      model: 'MacBook Pro',
      processor: 'M2',
      ram_gb: 16,
      storage_gb: 512,
      screen_size_in: 14,
      battery_health_pct: 92,
      battery_cycle_count: 50,
      condition: 'Excellent',
      acquisition_cost: 45000,
    });

    const row = await exportedRow(id);

    expectFields(row, {
      category: 'electronics',
      brand: 'Apple',
      model: 'MacBook Pro',
      processor: 'M2',
      ram_gb: '16',
      storage_gb: '512',
      screen_size_in: '14',
      battery_health_pct: '92',
      battery_cycle_count: '50',
      condition: 'Excellent',
      acquisition_cost_usd: '450.00',
    });
    // book/clothing-only columns must be blank on an electronics row
    expect(row.isbn).toBe('');
    expect(row.author).toBe('');
    expect(row.size_label).toBe('');
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('exports a clothing row with all nullable detail fields blank', async () => {
    const id = insertClothingItem();

    const row = await exportedRow(id);

    expectFields(row, {
      color: '',
      material: '',
      gender_department: '',
      weight_oz: '',
      pit_to_pit_in: '',
      length_in: '',
      sleeve_length_in: '',
      waist_in: '',
      rise_in: '',
      inseam_in: '',
      leg_opening_in: '',
      hip_in: '',
    });
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('computes gross_profit_usd for a Sold item, blank listing/sale fields otherwise', async () => {
    const soldId = insertBookItem({
      status: 'Sold',
      acquisition_cost: 500,
      listing_price: 1500,
      sale_price: 1500,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });
    const unlistedId = insertBookItem({ title: 'Still Unlisted' });

    const rows = await exportedRows();

    const soldRow = rows.find((r) => r.id === soldId)!;
    expectFields(soldRow, {
      status: 'Sold',
      sale_price_usd: '15.00',
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });
    expect(soldRow.gross_profit_usd).toBe('10.00'); // 1500 - 500 cents

    const unlistedRow = rows.find((r) => r.id === unlistedId)!;
    expect(unlistedRow.gross_profit_usd).toBe('');
    expect(unlistedRow.listing_price_usd).toBe('');
    expect(unlistedRow.sale_price_usd).toBe('');
  });

  it('joins multiple platforms into a comma-separated platforms column', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1200 });
    addPlatform(id, 'eBay');
    addPlatform(id, 'AbeBooks');

    const row = await exportedRow(id);

    expect(row.platforms.split(',').sort()).toEqual(['AbeBooks', 'eBay']);
  });

  it('an item with no platforms exports an empty platforms cell', async () => {
    const id = insertBookItem();
    const row = await exportedRow(id);
    expect(row.platforms).toBe('');
    // default insertBookItem() leaves isbn null — the fallback must yield ''
    expect(row.isbn).toBe('');
  });
});

describe('GET /api/export', () => {
  beforeEach(setupGETApiExport);

  it('sanitizes a formula-like title to prevent CSV injection', async () => {
    const id = insertBookItem({ title: '=SUM(A1:A9)' });
    const row = await exportedRow(id);
    // sanitize() prepends a tab before values starting with = + - @
    expect(row.title).toBe('\t=SUM(A1:A9)');
  });

  it('does not sanitize a normal title', async () => {
    const id = insertBookItem({ title: 'Normal Title' });
    const row = await exportedRow(id);
    expect(row.title).toBe('Normal Title');
  });

  it('returns 500 with plain-text body when the query throws', async () => {
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const res = await GET(exportRequest());
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('Internal server error');
    } finally {
      spy.mockRestore();
    }
  });
});
