import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import Papa from 'papaparse';
import db from '@/lib/db';
import { GET } from '@/app/api/export/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers — mirrors tests/integration.test.ts's insert helpers so rows land
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
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Test Author',
    publisher: 'Test Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book', tenant_id: currentTenant.tenantId };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition, tenant_id)
    VALUES (@id, @isbn, @author, @publisher, @condition, @tenant_id)
  `).run(item);
  return id;
}

function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'TestBrand',
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
  const item = { ...defaults, ...overrides, id, category: 'clothing', tenant_id: currentTenant.tenantId };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
  db.prepare(`
    INSERT INTO clothing_details
      (item_id, brand, size_label, color, material, gender_department, weight_oz,
       pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
       leg_opening_in, hip_in, condition, tenant_id)
    VALUES
      (@id, @brand, @size_label, @color, @material, @gender_department, @weight_oz,
       @pit_to_pit_in, @length_in, @sleeve_length_in, @waist_in, @rise_in, @inseam_in,
       @leg_opening_in, @hip_in, @condition, @tenant_id)
  `).run(item);
  return id;
}

function insertElectronicsItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Laptop',
    acquisition_cost: 45000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    device_type: 'laptop',
    brand: 'Apple',
    model: 'MacBook Pro',
    processor: null,
    ram_gb: null,
    storage_gb: null,
    screen_size_in: null,
    battery_health_pct: null,
    battery_cycle_count: null,
    condition: 'Excellent',
  };
  const item = { ...defaults, ...overrides, id, category: 'electronics', tenant_id: currentTenant.tenantId };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
  db.prepare(`
    INSERT INTO electronics_details
      (item_id, device_type, brand, model, processor, ram_gb, storage_gb,
       screen_size_in, battery_health_pct, battery_cycle_count, condition, tenant_id)
    VALUES
      (@id, @device_type, @brand, @model, @processor, @ram_gb, @storage_gb,
       @screen_size_in, @battery_health_pct, @battery_cycle_count, @condition, @tenant_id)
  `).run(item);
  return id;
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

describe('GET /api/export', () => {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });

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

  it('exports a book row with book fields populated and clothing fields blank', async () => {
    const id = insertBookItem({
      title: 'Dune',
      author: 'Frank Herbert',
      publisher: 'Chilton',
      isbn: '9780593099322',
      condition: 'Very Good',
      acquisition_cost: 550,
    });

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row).toBeTruthy();
    expect(row.category).toBe('book');
    expect(row.title).toBe('Dune');
    expect(row.author).toBe('Frank Herbert');
    expect(row.publisher).toBe('Chilton');
    expect(row.isbn).toBe('9780593099322');
    expect(row.condition).toBe('Very Good');
    expect(row.acquisition_cost_usd).toBe('5.50');
    expect(row.status).toBe('Unlisted');
    // clothing-only columns must be blank on a book row
    expect(row.brand).toBe('');
    expect(row.size_label).toBe('');
    expect(row.color).toBe('');
    expect(row.weight_oz).toBe('');
    expect(row.material).toBe('');
    expect(row.pit_to_pit_in).toBe('');
    expect(row.length_in).toBe('');
    expect(row.sleeve_length_in).toBe('');
    expect(row.waist_in).toBe('');
    expect(row.rise_in).toBe('');
    expect(row.inseam_in).toBe('');
    expect(row.leg_opening_in).toBe('');
    expect(row.hip_in).toBe('');
    // sale fields blank on an unsold item
    expect(row.sale_platform).toBe('');
    expect(row.sale_date).toBe('');
    // exact acquisition_date and non-blank timestamps
    expect(row.acquisition_date).toBe('2024-01-01');
    expect(row.created_at).not.toBe('');
    expect(row.updated_at).not.toBe('');
  });

  it('exports a book row with nullable isbn/publisher left blank', async () => {
    const id = insertBookItem({ isbn: null, publisher: null });

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row.isbn).toBe('');
    expect(row.publisher).toBe('');
  });

  it('exports a clothing row with clothing fields populated and book fields blank', async () => {
    const id = insertClothingItem({
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
    });

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row.category).toBe('clothing');
    expect(row.brand).toBe('Patagonia');
    expect(row.size_label).toBe('L');
    expect(row.color).toBe('Green');
    expect(row.material).toBe('Fleece');
    expect(row.gender_department).toBe('Mens');
    expect(row.weight_oz).toBe('18');
    expect(row.pit_to_pit_in).toBe('22.5');
    expect(row.length_in).toBe('30');
    expect(row.sleeve_length_in).toBe('24.5');
    expect(row.waist_in).toBe('32');
    expect(row.rise_in).toBe('11.5');
    expect(row.inseam_in).toBe('30');
    expect(row.leg_opening_in).toBe('7.25');
    expect(row.hip_in).toBe('42');
    expect(row.condition).toBe('NWT');
    expect(row.acquisition_cost_usd).toBe('42.00');
    // book-only columns must be blank on a clothing row
    expect(row.isbn).toBe('');
    expect(row.author).toBe('');
    expect(row.publisher).toBe('');
  });

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

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row.category).toBe('electronics');
    expect(row.brand).toBe('Apple');
    expect(row.model).toBe('MacBook Pro');
    expect(row.processor).toBe('M2');
    expect(row.ram_gb).toBe('16');
    expect(row.storage_gb).toBe('512');
    expect(row.screen_size_in).toBe('14');
    expect(row.battery_health_pct).toBe('92');
    expect(row.battery_cycle_count).toBe('50');
    expect(row.condition).toBe('Excellent');
    expect(row.acquisition_cost_usd).toBe('450.00');
    // book/clothing-only columns must be blank on an electronics row
    expect(row.isbn).toBe('');
    expect(row.author).toBe('');
    expect(row.size_label).toBe('');
  });

  it('exports a clothing row with all nullable detail fields blank', async () => {
    const id = insertClothingItem();

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row.color).toBe('');
    expect(row.material).toBe('');
    expect(row.gender_department).toBe('');
    expect(row.weight_oz).toBe('');
    expect(row.pit_to_pit_in).toBe('');
    expect(row.length_in).toBe('');
    expect(row.sleeve_length_in).toBe('');
    expect(row.waist_in).toBe('');
    expect(row.rise_in).toBe('');
    expect(row.inseam_in).toBe('');
    expect(row.leg_opening_in).toBe('');
    expect(row.hip_in).toBe('');
  });

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

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });

    const soldRow = parsed.data.find((r) => r.id === soldId)!;
    expect(soldRow.status).toBe('Sold');
    expect(soldRow.sale_price_usd).toBe('15.00');
    expect(soldRow.sale_platform).toBe('eBay');
    expect(soldRow.sale_date).toBe('2024-06-01');
    expect(soldRow.gross_profit_usd).toBe('10.00'); // 1500 - 500 cents

    const unlistedRow = parsed.data.find((r) => r.id === unlistedId)!;
    expect(unlistedRow.gross_profit_usd).toBe('');
    expect(unlistedRow.listing_price_usd).toBe('');
    expect(unlistedRow.sale_price_usd).toBe('');
  });

  it('joins multiple platforms into a comma-separated platforms column', async () => {
    const id = insertBookItem({ status: 'Listed', listing_price: 1200 });
    addPlatform(id, 'eBay');
    addPlatform(id, 'AbeBooks');

    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;

    expect(row.platforms.split(',').sort()).toEqual(['AbeBooks', 'eBay']);
  });

  it('an item with no platforms exports an empty platforms cell', async () => {
    const id = insertBookItem();
    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;
    expect(row.platforms).toBe('');
    // default insertBookItem() leaves isbn null — the fallback must yield ''
    expect(row.isbn).toBe('');
  });

  it('sanitizes a formula-like title to prevent CSV injection', async () => {
    const id = insertBookItem({ title: '=SUM(A1:A9)' });
    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;
    // sanitize() prepends a tab before values starting with = + - @
    expect(row.title).toBe('\t=SUM(A1:A9)');
  });

  it('does not sanitize a normal title', async () => {
    const id = insertBookItem({ title: 'Normal Title' });
    const res = await GET(exportRequest());
    const text = await res.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const row = parsed.data.find((r) => r.id === id)!;
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
