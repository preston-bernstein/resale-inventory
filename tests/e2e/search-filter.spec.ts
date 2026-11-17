import { test, expect, type Page } from '@playwright/test';
import { findItemCard, createBookItem, createClothingItem, uniqueSuffix } from './inventoryPage';

function filterControls(page: Page) {
  // The three filter <select> elements have no accessible <label>, so
  // locate them positionally in DOM order (category, condition, status)
  // as rendered by components/ItemSearch.tsx.
  return {
    searchInput: page.getByPlaceholder('Search title or author…'),
    categorySelect: page.locator('select').nth(0),
    conditionSelect: page.locator('select').nth(1),
    statusSelect: page.locator('select').nth(2),
  };
}

type FilterControls = ReturnType<typeof filterControls>;

// Free-text search.
async function searchByFreeText(page: Page, filters: FilterControls, bookTitle: string, clothingBrand: string) {
  await filters.searchInput.fill(bookTitle.slice(0, -4)); // partial match on the unique title
  await expect(findItemCard(page, bookTitle)).toBeVisible();
  await expect(findItemCard(page, clothingBrand)).toHaveCount(0);

  // Reset search before moving to category filter.
  await filters.searchInput.fill('');
}

// Category filter.
async function filterByCategory(page: Page, filters: FilterControls, bookTitle: string, clothingBrand: string) {
  await expect(filters.conditionSelect).toBeDisabled();
  await filters.categorySelect.selectOption('clothing');
  await expect(filters.conditionSelect).toBeEnabled();

  // Search is cleared but category=clothing should hide the book row and
  // show the clothing row. Use the clothing brand's search text to keep
  // this assertion scoped to our own created rows regardless of other
  // clothing rows from prior runs.
  await filters.searchInput.fill(clothingBrand);
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
  await expect(findItemCard(page, bookTitle)).toHaveCount(0);
}

// Condition filter combined with category.
async function filterByConditionWithinCategory(page: Page, filters: FilterControls, clothingBrand: string) {
  const conditionOptionTexts = await filters.conditionSelect.locator('option').allTextContents();
  expect(conditionOptionTexts).toContain('EUC');
  expect(conditionOptionTexts).not.toContain('Very Good');

  await filters.conditionSelect.selectOption('EUC');
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
}

// Status filter.
async function filterByStatus(page: Page, filters: FilterControls, bookTitle: string, clothingBrand: string) {
  await filters.searchInput.fill('');
  await filters.categorySelect.selectOption('');
  await filters.statusSelect.selectOption('Unlisted');
  await expect(findItemCard(page, bookTitle)).toBeVisible();
  await expect(findItemCard(page, clothingBrand)).toBeVisible();
}

// Clear button resets every filter.
async function clearFilters(page: Page, filters: FilterControls, bookTitle: string) {
  await filters.searchInput.fill(bookTitle);
  await filters.categorySelect.selectOption('book');
  await filters.statusSelect.selectOption('Unlisted');
  await page.getByRole('button', { name: 'Clear' }).click();

  await expect(filters.searchInput).toHaveValue('');
  await expect(filters.categorySelect).toHaveValue('');
  await expect(filters.statusSelect).toHaveValue('');
  await expect(filters.conditionSelect).toBeDisabled();
}

test.describe('Inventory search and filters', () => {
  test('free-text search, category filter, condition filter, status filter, and clear', async ({ page }) => {
    const suffix = uniqueSuffix();
    const bookTitle = `SearchTestBook-${suffix}`;
    const clothingBrand = `SearchTestBrand-${suffix}`;
    await createBookItem(page, { title: bookTitle, author: 'Test Author', cost: '9.99', date: '2026-01-01' });
    await createClothingItem(page, clothingBrand);

    // We should already be on /inventory after the second creation redirect.
    await expect(page).toHaveURL(/\/inventory$/);

    const filters = filterControls(page);

    await searchByFreeText(page, filters, bookTitle, clothingBrand);
    await filterByCategory(page, filters, bookTitle, clothingBrand);
    await filterByConditionWithinCategory(page, filters, clothingBrand);
    await filterByStatus(page, filters, bookTitle, clothingBrand);
    await clearFilters(page, filters, bookTitle);
  });
});
