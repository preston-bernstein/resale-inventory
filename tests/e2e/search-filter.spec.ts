import { test, expect, type Page } from '@playwright/test';
import { inputByLabel } from './helpers';

// Creates a unique-suffixed book and clothing item via the real UI (never
// touches the DB directly) so the search/filter tests have known data to
// filter against. Returns the unique strings used so callers can assert on
// them without depending on total row counts (the scratch DB persists
// across runs within a CI job, per playwright.config.ts).
async function createBookAndClothing(page: Page) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const bookTitle = `SearchTestBook-${suffix}`;
  const clothingBrand = `SearchTestBrand-${suffix}`;

  // Book
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await inputByLabel(page, 'Title *').fill(bookTitle);
  await inputByLabel(page, 'Author *').fill('Test Author');
  await inputByLabel(page, 'Condition *').selectOption('Good');
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill('9.99');
  await inputByLabel(page, 'Acquisition Date *').fill('2026-01-01');
  await page.getByRole('button', { name: 'Add Book' }).click();
  await page.waitForURL('**/inventory');

  // Clothing
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Clothing', exact: true }).click();
  await inputByLabel(page, 'Brand *').fill(clothingBrand);
  await inputByLabel(page, 'Size *').fill('M');
  await inputByLabel(page, 'Condition *').selectOption('EUC');
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill('19.99');
  await inputByLabel(page, 'Acquisition Date *').fill('2026-01-01');
  await page.getByRole('button', { name: 'Add Clothing Item' }).click();
  await page.waitForURL('**/inventory');

  return { bookTitle, clothingBrand };
}

test.describe('Inventory search and filters', () => {
  test('free-text search, category filter, condition filter, status filter, and clear', async ({ page }) => {
    const { bookTitle, clothingBrand } = await createBookAndClothing(page);

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
    await expect(page.getByRole('row', { name: new RegExp(bookTitle) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(clothingBrand) })).toHaveCount(0);

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
    await expect(page.getByRole('row', { name: new RegExp(clothingBrand) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(bookTitle) })).toHaveCount(0);

    // --- 3. Condition filter combined with category ---
    const conditionOptionTexts = await conditionSelect.locator('option').allTextContents();
    expect(conditionOptionTexts).toContain('EUC');
    expect(conditionOptionTexts).not.toContain('Very Good');

    await conditionSelect.selectOption('EUC');
    await expect(page.getByRole('row', { name: new RegExp(clothingBrand) })).toBeVisible();

    // --- 4. Status filter ---
    await searchInput.fill('');
    await categorySelect.selectOption('');
    await statusSelect.selectOption('Unlisted');
    await expect(page.getByRole('row', { name: new RegExp(bookTitle) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(clothingBrand) })).toBeVisible();

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
