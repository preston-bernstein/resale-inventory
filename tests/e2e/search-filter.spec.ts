import { test, expect } from '@playwright/test';
import { findItemCard, createBookItem, createClothingItem, uniqueSuffix } from './helpers';

test.describe('Inventory search and filters', () => {
  test('free-text search, category filter, condition filter, status filter, and clear', async ({ page }) => {
    const suffix = uniqueSuffix();
    const bookTitle = `SearchTestBook-${suffix}`;
    const clothingBrand = `SearchTestBrand-${suffix}`;
    await createBookItem(page, { title: bookTitle, author: 'Test Author', cost: '9.99', date: '2026-01-01' });
    await createClothingItem(page, clothingBrand);

    // We should already be on /inventory after the second creation redirect.
    await expect(page).toHaveURL(/\/inventory$/);

    const searchInput = page.getByPlaceholder('Search title or author…');
    // The three filter <select> elements have no accessible <label>, so
    // locate them positionally in DOM order (category, condition, status)
    // as rendered by components/ItemSearch.tsx.
    const categorySelect = page.locator('select').nth(0);
    const conditionSelect = page.locator('select').nth(1);
    const statusSelect = page.locator('select').nth(2);

    // --- 1. Free-text search ---
    await searchInput.fill(bookTitle.slice(0, -4)); // partial match on the unique title
    await expect(findItemCard(page, bookTitle)).toBeVisible();
    await expect(findItemCard(page, clothingBrand)).toHaveCount(0);

    // Reset search before moving to category filter.
    await searchInput.fill('');

    // --- 2. Category filter ---
    await expect(conditionSelect).toBeDisabled();
    await categorySelect.selectOption('clothing');
    await expect(conditionSelect).toBeEnabled();

    // Search is cleared but category=clothing should hide the book row and
    // show the clothing row. Use the clothing brand's search text to keep
    // this assertion scoped to our own created rows regardless of other
    // clothing rows from prior runs.
    await searchInput.fill(clothingBrand);
    await expect(findItemCard(page, clothingBrand)).toBeVisible();
    await expect(findItemCard(page, bookTitle)).toHaveCount(0);

    // --- 3. Condition filter combined with category ---
    const conditionOptionTexts = await conditionSelect.locator('option').allTextContents();
    expect(conditionOptionTexts).toContain('EUC');
    expect(conditionOptionTexts).not.toContain('Very Good');

    await conditionSelect.selectOption('EUC');
    await expect(findItemCard(page, clothingBrand)).toBeVisible();

    // --- 4. Status filter ---
    await searchInput.fill('');
    await categorySelect.selectOption('');
    await statusSelect.selectOption('Unlisted');
    await expect(findItemCard(page, bookTitle)).toBeVisible();
    await expect(findItemCard(page, clothingBrand)).toBeVisible();

    // --- 5. Clear button ---
    await searchInput.fill(bookTitle);
    await categorySelect.selectOption('book');
    await statusSelect.selectOption('Unlisted');
    await page.getByRole('button', { name: 'Clear' }).click();

    await expect(searchInput).toHaveValue('');
    await expect(categorySelect).toHaveValue('');
    await expect(statusSelect).toHaveValue('');
    await expect(conditionSelect).toBeDisabled();
  });
});
