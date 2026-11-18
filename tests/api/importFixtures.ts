import { afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import db from '@/lib/db';
import { POST } from '@/app/api/import/route';
import { createTestTenant } from '../helpers/tenant';

// ---------------------------------------------------------------------------
// Shared fixtures for the /api/import route tests.
// ---------------------------------------------------------------------------

// Task 21 retrofit (finished by Task 22): this route now requires a tenant
// session cookie. A fresh tenant is created per test (see beforeEach below)
// and stashed here so postImport() below can attach it without every call
// site needing to be touched individually.
let currentTenant: ReturnType<typeof createTestTenant>;

const CSV_COLUMNS = [
  'category', 'title', 'author', 'publisher', 'isbn', 'condition',
  'acquisition_cost_usd', 'acquisition_date',
  'brand', 'size_label', 'color', 'material', 'gender_department', 'weight_oz',
  'pit_to_pit_in', 'length_in', 'sleeve_length_in', 'waist_in', 'rise_in',
  'inseam_in', 'leg_opening_in', 'hip_in',
  'model', 'processor', 'ram_gb', 'storage_gb', 'screen_size_in',
  'battery_health_pct', 'battery_cycle_count',
] as const;

export type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string>>;

export function toCsv(rows: CsvRow[]): string {
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

export function csvFile(text: string, name = 'import.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

export function bookRow(overrides: CsvRow = {}): CsvRow {
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

export function clothingRow(overrides: CsvRow = {}): CsvRow {
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

export function electronicsRow(overrides: CsvRow = {}): CsvRow {
  return {
    category: 'electronics',
    brand: 'Apple',
    model: 'MacBook Pro',
    condition: 'Excellent',
    acquisition_cost_usd: '450.00',
    acquisition_date: '2024-01-01',
    ...overrides,
  };
}

export async function postImport(body: FormData | string, headers: Record<string, string> = {}) {
  const withCookie =
    currentTenant && !headers.Cookie ? { ...headers, Cookie: currentTenant.cookieHeader } : headers;
  const req = new NextRequest('http://localhost/api/import', {
    method: 'POST',
    headers: withCookie,
    body: body as unknown as BodyInit,
  });
  return POST(req);
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM electronics_details; DELETE FROM items;',
  );
}

/** Per test: wipe the item tables and sign up a fresh tenant for postImport() to use. */
export function useFreshImportTenant() {
  beforeEach(() => {
    cleanTables();
    currentTenant = createTestTenant();
  });
  // Leave no rows behind: other test files clean only some of these tables, so
  // a leftover electronics row would break their DELETE FROM items.
  afterAll(cleanTables);
}
