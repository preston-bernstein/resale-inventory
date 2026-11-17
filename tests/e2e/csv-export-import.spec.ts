import { test, expect, type Page } from '@playwright/test';
import Papa from 'papaparse';
import { createBookItem, findItemCard, uniqueSuffix } from './inventoryPage';

// Column order emitted by GET /api/export and expected by POST /api/import.
// Kept in sync manually with app/api/export/route.ts's HEADERS constant.
const CSV_HEADERS = [
  'id', 'category', 'title', 'isbn', 'author', 'publisher',
  'brand', 'size_label', 'color', 'material', 'gender_department',
  'weight_oz', 'pit_to_pit_in', 'length_in', 'sleeve_length_in',
  'waist_in', 'rise_in', 'inseam_in', 'leg_opening_in', 'hip_in',
  'condition', 'acquisition_cost_usd', 'acquisition_date', 'status',
  'listing_price_usd', 'platforms', 'sale_price_usd', 'sale_platform',
  'sale_date', 'gross_profit_usd', 'created_at', 'updated_at',
];

function buildCsvRow(fields: Partial<Record<(typeof CSV_HEADERS)[number], string>>): string {
  return CSV_HEADERS.map((h) => fields[h] ?? '').join(',');
}

function buildCsv(rows: Partial<Record<(typeof CSV_HEADERS)[number], string>>[]): string {
  return [CSV_HEADERS.join(','), ...rows.map(buildCsvRow)].join('\n');
}

function postImport(page: Page, csv: string, name: string) {
  return page.request.post('/api/import', {
    multipart: {
      file: {
        name,
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      },
    },
  });
}

async function exportRows(page: Page) {
  const exportRes = await page.request.get('/api/export');
  expect(exportRes.status()).toBe(200);
  const exportBody = await exportRes.text();

  const parsed = Papa.parse<Record<string, string>>(exportBody, { header: true, skipEmptyLines: true });
  expect(parsed.errors).toHaveLength(0);
  return parsed.data;
}

function findExportedRow(rows: Record<string, string>[], title: string, label: string) {
  const row = rows.find((r) => r.title === title);
  if (!row) throw new Error(`${label} row "${title}" not found in export.`);
  return row;
}

function expectFields(row: Record<string, string>, expected: Record<string, string>) {
  for (const [column, value] of Object.entries(expected)) {
    expect(row[column], column).toBe(value);
  }
}

const ROUND_TRIP_CLOTHING_FIELDS = {
  brand: 'Round Trip Brand',
  size_label: 'M',
  color: 'Navy',
  material: 'Cotton',
  gender_department: 'Womens',
  weight_oz: '14',
  pit_to_pit_in: '20.5',
  length_in: '28',
  sleeve_length_in: '24.5',
  waist_in: '16',
  rise_in: '11.5',
  inseam_in: '30',
  leg_opening_in: '7.5',
  hip_in: '19',
  condition: 'EUC',
  acquisition_cost_usd: '45.67',
  acquisition_date: '2026-03-11',
};

function buildRoundTripCsv(bookTitle: string, clothingTitle: string, isbn: string): string {
  return buildCsv([
    {
      category: 'book',
      title: bookTitle,
      isbn,
      author: 'Round Trip Author',
      publisher: 'Round Trip Publisher',
      condition: 'Good',
      acquisition_cost_usd: '19.99',
      acquisition_date: '2026-03-10',
    },
    { category: 'clothing', title: clothingTitle, ...ROUND_TRIP_CLOTHING_FIELDS },
  ]);
}

function buildImportFixtureCsv(importBrand: string, importedTitle: string): string {
  return buildCsv([
    {
      category: 'clothing',
      title: importedTitle,
      brand: importBrand,
      size_label: 'M',
      condition: 'EUC',
      acquisition_cost_usd: '15.00',
      acquisition_date: '2026-01-20',
    },
    {
      // Invalid: clothing row missing required size_label.
      category: 'clothing',
      title: `${importBrand}-invalid`,
      brand: importBrand,
      condition: 'EUC',
      acquisition_cost_usd: '20.00',
      acquisition_date: '2026-01-21',
    },
  ]);
}

// The three tests below share one suffix, because test 3 reads the row that
// test 2 imports. The suffix is set in beforeAll, not at module scope, so each
// --repeat-each iteration gets a fresh one and rows left in the scratch DB by
// an earlier run cannot collide.
test.describe('CSV export/import', () => {
  let bookTitle: string;
  let importBrand: string;
  let importedTitle: string;

  test.beforeAll(() => {
    const suffix = uniqueSuffix();
    bookTitle = `CSVTestBook-${suffix}`;
    importBrand = `CSVImportBrand-${suffix}`;
    importedTitle = `${importBrand} Jacket`;
  });

  test('creates a book via the UI, then GET /api/export includes it with the expected columns', async ({ page }) => {
    await createBookItem(page, { title: bookTitle, author: 'E2E Test Author', cost: '9.99', date: '2026-01-15' });

    const res = await page.request.get('/api/export');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');

    const body = await res.text();
    expect(body).toContain(bookTitle);

    const firstLine = body.split(/\r?\n/)[0];
    for (const col of ['id', 'category', 'title', 'isbn', 'author', 'condition', 'acquisition_cost_usd']) {
      expect(firstLine).toContain(col);
    }
  });

  test('POST /api/import commits a valid clothing row and reports a per-row error for the invalid one', async ({ page }) => {
    const csv = buildImportFixtureCsv(importBrand, importedTitle);

    const res = await postImport(page, csv, 'test.csv');

    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.imported).toBe(1);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].fields).toContain('size_label');
  });

  test('the imported clothing row is visible in the inventory search results', async ({ page }) => {
    await page.goto('/inventory');

    await page.getByPlaceholder('Search title or author…').fill(importBrand);

    const card = findItemCard(page, importedTitle);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Clothing');
  });
});

// Independent of the shared suffix above: it imports and exports its own rows, so it
// can sit in its own describe.
test.describe('CSV export/import', () => {
  test('full-field round trip: every import-eligible book and clothing column survives export unchanged', async ({ page }) => {
    const rtSuffix = uniqueSuffix();
    const bookRtTitle = `FullRoundTripBook-${rtSuffix}`;
    const clothingRtTitle = `FullRoundTripClothing-${rtSuffix}`;
    const isbn = Date.now().toString();

    const csv = buildRoundTripCsv(bookRtTitle, clothingRtTitle, isbn);

    const importRes = await postImport(page, csv, 'full-round-trip.csv');

    expect(importRes.status()).toBe(200);
    const importJson = await importRes.json();
    expect(importJson.imported).toBe(2);
    expect(importJson.errors).toHaveLength(0);

    const rows = await exportRows(page);
    const bookRow = findExportedRow(rows, bookRtTitle, 'Book');
    const clothingRow = findExportedRow(rows, clothingRtTitle, 'Clothing');

    // Book row: every import-eligible book column round-trips byte-for-byte.
    expectFields(bookRow, {
      category: 'book',
      isbn,
      author: 'Round Trip Author',
      publisher: 'Round Trip Publisher',
      condition: 'Good',
      acquisition_cost_usd: '19.99',
      acquisition_date: '2026-03-10',
      status: 'Unlisted',
    });

    // Clothing row: every import-eligible clothing column round-trips byte-for-byte.
    expectFields(clothingRow, { category: 'clothing', ...ROUND_TRIP_CLOTHING_FIELDS, status: 'Unlisted' });
  });
});
