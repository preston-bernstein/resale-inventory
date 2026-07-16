import { test, expect } from '@playwright/test';
import { createBookItem, createClothingItem, uniqueSuffix } from './helpers';

test.describe('Dashboard', () => {
  test('renders stats, by-category, by-condition, and by-status sections', async ({ page }) => {
    const suffix = uniqueSuffix();
    const bookTitle = `DashboardTestBook-${suffix}`;
    const clothingBrand = `DashboardTestBrand-${suffix}`;
    await createBookItem(page, { title: bookTitle, author: 'Test Author', cost: '12.34', date: '2026-01-01' });
    await createClothingItem(page, clothingBrand);

    // --- 1. Navigate and verify top stat cards ---
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const itemsHeldCard = page.getByText('Items Held').locator('..');
    await expect(itemsHeldCard).toContainText(/\d+/);

    const acquisitionCostCard = page.getByText('Acquisition Cost (Held)').locator('..');
    await expect(acquisitionCostCard).toContainText(/\$[\d,]+\.\d{2}/);

    // --- 2. By Category: both Books and Clothing sub-sections, count >= 1 ---
    // "Books"/"Clothing" sub-headings appear in BOTH the By Category and By
    // Condition sections simultaneously (both always render, not
    // sequentially), so scope every lookup to its containing section rather
    // than querying by heading text globally.
    const byCategorySection = page.getByRole('heading', { name: 'By Category' }).locator('..');
    await expect(byCategorySection).toBeVisible();
    const booksCategoryHeading = byCategorySection.getByRole('heading', { name: /^Books$/i });
    const clothingCategoryHeading = byCategorySection.getByRole('heading', { name: /^Clothing$/i });
    await expect(booksCategoryHeading).toBeVisible();
    await expect(clothingCategoryHeading).toBeVisible();

    // Each sub-section is a sibling block containing "Count" and a numeric
    // value — walk up to the shared container and assert the count row.
    const booksCategoryBlock = booksCategoryHeading.locator('..');
    const clothingCategoryBlock = clothingCategoryHeading.locator('..');
    await expect(booksCategoryBlock.getByText('Count')).toBeVisible();
    await expect(clothingCategoryBlock.getByText('Count')).toBeVisible();

    const booksCount = await booksCategoryBlock
      .locator('dd')
      .first()
      .textContent();
    const clothingCount = await clothingCategoryBlock
      .locator('dd')
      .first()
      .textContent();
    expect(Number(booksCount)).toBeGreaterThanOrEqual(1);
    expect(Number(clothingCount)).toBeGreaterThanOrEqual(1);

    // --- 3. By Condition: Books sub-group and Clothing sub-group ---
    const byConditionSection = page.getByRole('heading', { name: 'By Condition' }).locator('..');
    await expect(byConditionSection).toBeVisible();
    await expect(byConditionSection.getByRole('heading', { name: /^Books$/i })).toBeVisible();
    await expect(byConditionSection.getByRole('heading', { name: /^Clothing$/i })).toBeVisible();
    // Two "Books" headings and two "Clothing" headings exist on the whole
    // page (one under By Category, one under By Condition).
    await expect(page.getByRole('heading', { name: /^Books$/i })).toHaveCount(2);
    await expect(page.getByRole('heading', { name: /^Clothing$/i })).toHaveCount(2);

    await expect(byConditionSection.getByText('Good', { exact: true })).toBeVisible();
    await expect(byConditionSection.getByText('EUC', { exact: true })).toBeVisible();

    // --- 4. By Status: Unlisted with count >= 1 ---
    await expect(page.getByRole('heading', { name: 'By Status' })).toBeVisible();
    const byStatusSection = page.getByRole('heading', { name: 'By Status' }).locator('..');
    const unlistedRow = byStatusSection.locator('div').filter({ hasText: 'Unlisted' }).last();
    await expect(unlistedRow).toBeVisible();
    const unlistedCountText = await unlistedRow.locator('dd').textContent();
    expect(Number(unlistedCountText)).toBeGreaterThanOrEqual(1);

    // --- 5. Refresh still renders correctly ---
    await page.getByRole('link', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By Category' })).toBeVisible();
  });
});
