import { test, expect } from '@playwright/test';
import { inputByLabel, findItemCard } from './helpers';

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

// A single suffix shared by every test in this file, so the scratch DB
// (never wiped between runs) can't produce stale collisions against a prior
// run's rows.
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const bookTitle = `CSVTestBook-${suffix}`;
const importBrand = `CSVImportBrand-${suffix}`;
const importedTitle = `${importBrand} Jacket`;

test.describe('CSV export/import', () => {
  test('creates a book via the UI, then GET /api/export includes it with the expected columns', async ({ page }) => {
    await page.goto('/inventory/new');

    // Book is the default selected segment already, but click it explicitly
    // to be robust against default-state changes.
    await page.getByRole('button', { name: 'Book', exact: true }).click();

    await inputByLabel(page, 'Title *').fill(bookTitle);
    await inputByLabel(page, 'Author *').fill('E2E Test Author');
    // Condition * select defaults to "Good" — leave as-is.
    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('9.99');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-01-15');

    await page.getByRole('button', { name: 'Add Book' }).click();
    await expect(page).toHaveURL(/\/inventory$/);

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

    const res = await page.request.post('/api/import', {
      multipart: {
        file: {
          name: 'test.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv),
        },
      },
    });

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
