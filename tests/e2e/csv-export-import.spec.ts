import { test, expect, type Page } from '@playwright/test';
import Papa from 'papaparse';
import { createBookItem, findItemCard, uniqueSuffix } from './itemFlows';

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

type CsvFields = Partial<Record<(typeof CSV_HEADERS)[number], string>>;

/** Uploads `csv` to POST /api/import and returns the response with its parsed body. */
async function importCsv(page: Page, csv: string, fileName: string) {
  const res = await page.request.post('/api/import', {
    multipart: {
      file: {
        name: fileName,
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      },
    },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

// A single suffix shared by every test in the export and import describes,
// so the scratch DB (never wiped between runs) can't produce stale
// collisions against a prior run's rows. Assigned in beforeAll (rather than
// at module scope) so each --repeat-each iteration gets a fresh suffix —
// beforeAll re-runs per repeat, while still sharing one suffix across the
// three tests within a single iteration (Test 3 depends on the row Test 2
// creates using these same values).
let suffix: string;
let bookTitle: string;
let importBrand: string;
let importedTitle: string;

test.beforeAll(() => {
  suffix = uniqueSuffix();
  bookTitle = `CSVTestBook-${suffix}`;
  importBrand = `CSVImportBrand-${suffix}`;
  importedTitle = `${importBrand} Jacket`;
});

test.describe('CSV export/import — export', () => {
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
});

test.describe('CSV export/import — import', () => {
  test('POST /api/import commits a valid clothing row and reports a per-row error for the invalid one', async ({ page }) => {
    const csv = buildCsv([
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

    const json = await importCsv(page, csv, 'test.csv');
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

const ROUND_TRIP_BOOK: CsvFields = {
  category: 'book',
  author: 'Round Trip Author',
  publisher: 'Round Trip Publisher',
  condition: 'Good',
  acquisition_cost_usd: '19.99',
  acquisition_date: '2026-03-10',
};

const ROUND_TRIP_CLOTHING: CsvFields = {
  category: 'clothing',
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

/** Every import-eligible column of `expected` round-trips byte-for-byte, and the item starts Unlisted. */
function expectRowRoundTrips(row: Record<string, string>, expected: CsvFields) {
  for (const [column, value] of Object.entries({ ...expected, status: 'Unlisted' })) {
    expect(row[column], column).toBe(value);
  }
}

test.describe('CSV export/import round trip', () => {
  test('full-field round trip: every import-eligible book and clothing column survives export unchanged', async ({ page }) => {
    const rtSuffix = uniqueSuffix();
    const bookRtTitle = `FullRoundTripBook-${rtSuffix}`;
    const clothingRtTitle = `FullRoundTripClothing-${rtSuffix}`;
    const isbn = Date.now().toString();
    const book = { ...ROUND_TRIP_BOOK, title: bookRtTitle, isbn };
    const clothing = { ...ROUND_TRIP_CLOTHING, title: clothingRtTitle };

    const importJson = await importCsv(page, buildCsv([book, clothing]), 'full-round-trip.csv');
    expect(importJson.imported).toBe(2);
    expect(importJson.errors).toHaveLength(0);

    const exportRes = await page.request.get('/api/export');
    expect(exportRes.status()).toBe(200);
    const exportBody = await exportRes.text();

    const parsed = Papa.parse<Record<string, string>>(exportBody, { header: true, skipEmptyLines: true });
    expect(parsed.errors).toHaveLength(0);

    const bookRow = parsed.data.find((r) => r.title === bookRtTitle);
    const clothingRow = parsed.data.find((r) => r.title === clothingRtTitle);

    if (!bookRow) throw new Error(`Book row "${bookRtTitle}" not found in export.`);
    if (!clothingRow) throw new Error(`Clothing row "${clothingRtTitle}" not found in export.`);

    expectRowRoundTrips(bookRow, book);
    expectRowRoundTrips(clothingRow, clothing);
  });
});
