import { test, expect, type Page } from '@playwright/test';
import { findItemCard, createBookItem, createClothingItem, uniqueSuffix } from './itemFlows';

/**
 * The search box and the three filter <select> elements. The selects have no
 * accessible <label>, so they are located positionally in DOM order
 * (category, condition, status) as rendered by components/ItemSearch.tsx.
 */
function filterControls(page: Page) {
  return {
    searchInput: page.getByPlaceholder('Search title or author…'),
    categorySelect: page.locator('select').nth(0),
    conditionSelect: page.locator('select').nth(1),
    statusSelect: page.locator('select').nth(2),
  };
}

type FilterControls = ReturnType<typeof filterControls>;

interface Fixtures {
  bookTitle: string;
  clothingBrand: string;
}

async function expectFreeTextSearch(page: Page, controls: FilterControls, { bookTitle, clothingBrand }: Fixtures) {
  await controls.searchInput.fill(bookTitle.slice(0, -4)); // partial match on the unique title
  await expect(findItemCard(page, bookTitle)).toBeVisible();
  await expect(findItemCard(page, clothingBrand)).toHaveCount(0);

  // Reset search before moving to category filter.
  await controls.searchInput.fill('');
}

async function expectCategoryFilter(page: Page, controls: FilterControls, { bookTitle, clothingBrand }: Fixtures) {
  await expect(controls.conditionSelect).toBeDisabled();
  await controls.categorySelect.selectOption('clothing');
  await expect(controls.conditionSelect).toBeEnabled();

  // Search is cleared but category=clothing should hide the book row and
  // show the clothing row. Use the clothing brand's search text to keep
  // this assertion scoped to our own created rows regardless of other
  // clothing rows from prior runs.
  await controls.searchInput.fill(clothingBrand);
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
  await expect(findItemCard(page, bookTitle)).toHaveCount(0);
}

async function expectConditionFilter(page: Page, controls: FilterControls, { clothingBrand }: Fixtures) {
  const conditionOptionTexts = await controls.conditionSelect.locator('option').allTextContents();
  expect(conditionOptionTexts).toContain('EUC');
  expect(conditionOptionTexts).not.toContain('Very Good');

  await controls.conditionSelect.selectOption('EUC');
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
}

async function expectStatusFilter(page: Page, controls: FilterControls, { bookTitle, clothingBrand }: Fixtures) {
  await controls.searchInput.fill('');
  await controls.categorySelect.selectOption('');
  await controls.statusSelect.selectOption('Unlisted');
  await expect(findItemCard(page, bookTitle)).toBeVisible();
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
}

async function expectClearButton(page: Page, controls: FilterControls, { bookTitle }: Fixtures) {
  await controls.searchInput.fill(bookTitle);
  await controls.categorySelect.selectOption('book');
  await controls.statusSelect.selectOption('Unlisted');
  await page.getByRole('button', { name: 'Clear' }).click();

  await expect(controls.searchInput).toHaveValue('');
  await expect(controls.categorySelect).toHaveValue('');
  await expect(controls.statusSelect).toHaveValue('');
  await expect(controls.conditionSelect).toBeDisabled();
}

test.describe('Inventory search and filters', () => {
  test('free-text search, category filter, condition filter, status filter, and clear', async ({ page }) => {
    const suffix = uniqueSuffix();
    const fixtures = { bookTitle: `SearchTestBook-${suffix}`, clothingBrand: `SearchTestBrand-${suffix}` };
    await createBookItem(page, { title: fixtures.bookTitle, author: 'Test Author', cost: '9.99', date: '2026-01-01' });
    await createClothingItem(page, fixtures.clothingBrand);

    // We should already be on /inventory after the second creation redirect.
    await expect(page).toHaveURL(/\/inventory$/);

    const controls = filterControls(page);

    // --- 1. Free-text search ---
    await expectFreeTextSearch(page, controls, fixtures);
    // --- 2. Category filter ---
    await expectCategoryFilter(page, controls, fixtures);
    // --- 3. Condition filter combined with category ---
    await expectConditionFilter(page, controls, fixtures);
    // --- 4. Status filter ---
    await expectStatusFilter(page, controls, fixtures);
    // --- 5. Clear button ---
    await expectClearButton(page, controls, fixtures);
  });
});
