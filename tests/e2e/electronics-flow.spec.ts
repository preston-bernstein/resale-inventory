import { test, expect, type Page } from '@playwright/test';
import { inputByLabel, detailValue, uniqueSuffix, findItemCard, openItemDetail, createBookItem } from './helpers';

interface NewElectronicsItem {
  brand: string;
  model: string;
  processor?: string;
  ramGb?: string;
  batteryHealthPct?: string;
  cost: string;
  date: string;
}

/** Switches the Add Item page to the Electronics tab. */
async function openElectronicsTab(page: Page): Promise<void> {
  await page.goto('/inventory/new');
  await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();
  await page.getByRole('button', { name: 'Electronics', exact: true }).click();
}

/** Fills and submits the Add Electronics form. Leaves Condition at its default. */
async function addElectronics(page: Page, item: NewElectronicsItem): Promise<void> {
  await openElectronicsTab(page);

  await inputByLabel(page, 'Brand *').selectOption(item.brand);
  await inputByLabel(page, 'Model *').fill(item.model);
  if (item.processor) await inputByLabel(page, 'Processor').fill(item.processor);
  if (item.ramGb) await inputByLabel(page, 'RAM (GB)').fill(item.ramGb);
  if (item.batteryHealthPct) await inputByLabel(page, 'Battery Health (%)').fill(item.batteryHealthPct);
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill(item.cost);
  await inputByLabel(page, 'Acquisition Date *').fill(item.date);

  await page.getByRole('button', { name: 'Add Electronics Item' }).click();
  await page.waitForURL('**/inventory');
}

test.describe('Electronics flow', () => {
  test('adding an electronics item redirects to inventory and shows Category Electronics', async ({ page }) => {
    const model = `E2EMacBook${uniqueSuffix()}`;
    await addElectronics(page, {
      brand: 'Apple',
      model,
      processor: 'M2',
      ramGb: '16',
      batteryHealthPct: '92',
      cost: '450.00',
      date: '2026-01-20',
    });
    expect(page.url()).toMatch(/\/inventory\/?$/);

    await page.getByPlaceholder('Search title or author…').fill(model);
    const card = findItemCard(page, model);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Electronics');
  });

  test('electronics detail page shows brand, model, processor, RAM, and battery health', async ({ page }) => {
    const model = `E2EThinkPad${uniqueSuffix()}`;
    await addElectronics(page, {
      brand: 'Lenovo',
      model,
      processor: 'Intel i7-1260P',
      ramGb: '32',
      batteryHealthPct: '85',
      cost: '300.00',
      date: '2026-02-01',
    });
    await openItemDetail(page, model);

    expect(await detailValue(page, 'Brand')).toBe('Lenovo');
    expect(await detailValue(page, 'Model')).toBe(model);
    expect(await detailValue(page, 'Processor')).toBe('Intel i7-1260P');
    expect(await detailValue(page, 'RAM')).toContain('32');
    expect(await detailValue(page, 'Battery Health')).toContain('85');
  });

  test('submitting battery health outside 0-100 is rejected before the API call', async ({ page }) => {
    await openElectronicsTab(page);

    const model = `E2EBadBattery${uniqueSuffix()}`;
    await inputByLabel(page, 'Brand *').selectOption('Dell');
    await inputByLabel(page, 'Model *').fill(model);
    await inputByLabel(page, 'Battery Health (%)').fill('150');
    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('100.00');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-02-05');

    await page.getByRole('button', { name: 'Add Electronics Item' }).click();

    // Browser-native max="100" constraint validation blocks submission —
    // the page never navigates away from /inventory/new.
    await expect(page).toHaveURL(/\/inventory\/new$/);

    await page.goto('/inventory');
    await page.getByPlaceholder('Search title or author…').fill(model);
    await expect(page.getByRole('link', { name: new RegExp(model) })).toHaveCount(0);
  });

  test('platform picker: electronics item offers exactly Mercari/Poshmark/Amazon/eBay/Grailed/Swappa', async ({ page }) => {
    const model = `E2EPlatformPicker${uniqueSuffix()}`;
    await addElectronics(page, { brand: 'Asus', model, cost: '200.00', date: '2026-02-10' });
    await openItemDetail(page, model);

    const expectedPlatforms = ['mercari', 'poshmark', 'amazon', 'ebay', 'grailed', 'swappa'];
    for (const platform of expectedPlatforms) {
      await expect(page.getByRole('checkbox', { name: platform })).toBeVisible();
    }
    await expect(page.getByRole('checkbox', { name: 'etsy' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'depop' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'vinted' })).toHaveCount(0);
  });

  test('platform picker: a book item never offers Swappa', async ({ page }) => {
    const title = `E2EBookNoSwappa${uniqueSuffix()}`;
    await createBookItem(page, { title });
    await openItemDetail(page, title);

    await expect(page.getByRole('checkbox', { name: 'swappa' })).toHaveCount(0);
    // Sanity: the picker itself is present and offers book-appropriate platforms.
    await expect(page.getByRole('checkbox', { name: 'ebay' })).toBeVisible();
  });
});
