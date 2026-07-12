import { test, expect, type Page, type Locator } from '@playwright/test';
import { inputByLabel, detailValue, uniqueSuffix } from './helpers';

interface NewClothingItem {
  brand: string;
  size: string;
  color?: string;
  cost: string;
  date: string;
}

/** Switches the Add Item page to the Clothing tab. */
async function openClothingTab(page: Page): Promise<void> {
  await page.goto('/inventory/new');
  await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
}

/** Fills and submits the Add Clothing form. Leaves Condition at its EUC default. */
async function addClothing(page: Page, item: NewClothingItem): Promise<void> {
  await openClothingTab(page);

  await inputByLabel(page, 'Brand *').fill(item.brand);
  await inputByLabel(page, 'Size *').fill(item.size);
  if (item.color) await inputByLabel(page, 'Color').fill(item.color);
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill(item.cost);
  await inputByLabel(page, 'Acquisition Date *').fill(item.date);

  await page.getByRole('button', { name: 'Add Clothing Item' }).click();
  await page.waitForURL('**/inventory');
}

/** Filters the inventory list down to rows matching `title` and returns that row. */
async function findRow(page: Page, title: string): Promise<Locator> {
  await page.goto('/inventory');
  await page.getByPlaceholder('Search title or author…').fill(title);
  const row = page.getByRole('row', { name: title });
  await expect(row).toBeVisible();
  return row;
}

/** Navigates from the inventory list into a single item's detail page via its View link. */
async function openDetail(page: Page, title: string): Promise<void> {
  const row = await findRow(page, title);
  await row.getByRole('link', { name: 'View' }).click();
  await page.waitForURL(/\/inventory\/[^/]+$/);
}

test.describe('Clothing flow', () => {
  test('adding a clothing item redirects to inventory and shows Category Clothing, Condition EUC', async ({ page }) => {
    const brand = `E2EDenim${uniqueSuffix()}`;
    const size = '32x30';
    await addClothing(page, { brand, size, color: 'Indigo', cost: '8.00', date: '2026-01-20' });

    expect(page.url()).toMatch(/\/inventory\/?$/);

    // The auto-generated Listing Title (which becomes the item's title)
    // contains the brand string, so searching by brand finds our row.
    const row = await findRow(page, brand);
    await expect(row).toContainText('Clothing');
    await expect(row).toContainText('EUC');
  });

  test('Listing Title auto-populates from Brand and Size before submission', async ({ page }) => {
    await openClothingTab(page);

    const brand = `Levi's ${uniqueSuffix()}`;
    const size = '32x30';
    await inputByLabel(page, 'Brand *').fill(brand);
    await inputByLabel(page, 'Size *').fill(size);

    const suggestedTitle = await inputByLabel(page, 'Listing Title').inputValue();
    expect(suggestedTitle).toContain(brand);
    expect(suggestedTitle).toContain(size);
  });

  test('clothing detail page: Photos section, clothing-scoped Condition vocabulary, and full status lifecycle to Sold', async ({ page }) => {
    const brand = `E2EJacket${uniqueSuffix()}`;
    const size = '42R';
    await addClothing(page, { brand, size, color: 'Charcoal', cost: '6.50', date: '2026-02-05' });
    await openDetail(page, brand);

    await test.step('Photos section is present on a clothing item (unlike a book item)', async () => {
      await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    });

    await test.step('Edit Listing Condition select only offers clothing vocabulary', async () => {
      const options = await inputByLabel(page, 'Condition').locator('option').allTextContents();
      expect(options).toEqual(expect.arrayContaining(['NWT', 'NWOT', 'EUC', 'GUC', 'Fair']));
      expect(options).not.toContain('Very Good'); // book-only condition value
    });

    await test.step('set a Listing Price so Unlisted -> Listed is valid', async () => {
      await inputByLabel(page, 'Listing Price (USD)').fill('25.00');
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByText('Saved.')).toBeVisible();
    });

    await test.step('Unlisted -> Listed -> Sale Pending -> Sold, category-blind state machine (FR11/AC6)', async () => {
      await inputByLabel(page, 'Transition to').selectOption('Listed');
      await page.getByRole('button', { name: 'Set to Listed' }).click();
      await expect(async () => {
        expect(await detailValue(page, 'Status')).toBe('Listed');
      }).toPass();

      await inputByLabel(page, 'Transition to').selectOption('Sale Pending');
      await page.getByRole('button', { name: 'Set to Sale Pending' }).click();
      await expect(async () => {
        expect(await detailValue(page, 'Status')).toBe('Sale Pending');
      }).toPass();

      await inputByLabel(page, 'Transition to').selectOption('Sold');
      await inputByLabel(page, 'Sale Price (USD)').fill('30.00');
      await inputByLabel(page, 'Sale Platform').selectOption('Other');
      await inputByLabel(page, 'Sale Date').fill('2026-03-10');
      await page.getByRole('button', { name: 'Set to Sold' }).click();

      await expect(async () => {
        expect(await detailValue(page, 'Status')).toBe('Sold');
      }).toPass();

      await expect(page.getByRole('heading', { name: 'Price History' })).toBeVisible();
      const historyRows = page.locator('table', { has: page.getByRole('columnheader', { name: 'Previous' }) }).locator('tbody tr');
      await expect(historyRows).not.toHaveCount(0);

      // Terminal state: Edit Listing / Change Status sections are gone.
      await expect(page.getByRole('heading', { name: 'Edit Listing' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Change Status' })).toHaveCount(0);
    });
  });
});
