import { test, expect, type Page } from '@playwright/test';
import { inputByLabel, detailValue, uniqueSuffix, findItemCard, openItemDetail } from './helpers';

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

test.describe('Clothing flow', () => {
  test('adding a clothing item redirects to inventory and shows Category Clothing, Condition EUC', async ({ page }) => {
    const brand = `E2EDenim${uniqueSuffix()}`;
    const size = '32x30';
    await addClothing(page, { brand, size, color: 'Indigo', cost: '8.00', date: '2026-01-20' });

    expect(page.url()).toMatch(/\/inventory\/?$/);

    // The auto-generated Listing Title (which becomes the item's title)
    // contains the brand string, so searching by brand finds our card.
    await page.getByPlaceholder('Search title or author…').fill(brand);
    const card = findItemCard(page, brand);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Clothing');
    await expect(card).toContainText('EUC');
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
    await openItemDetail(page, brand);

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

  test('BrandCombobox: partial match of an existing brand can be clicked to select it, and the item submits successfully', async ({ page }) => {
    // First, create an item with a distinctive brand so it lands in the
    // canonical brand list (POST /api/items upserts it via resolveCanonicalBrand).
    const brand = `E2EComboMatch${uniqueSuffix()}`;
    await addClothing(page, { brand, size: 'M', cost: '5.00', date: '2026-01-10' });

    // Fresh visit to the form re-fetches GET /api/brands, which now includes it.
    await openClothingTab(page);
    const combo = page.getByRole('combobox', { name: /brand/i });
    const partial = brand.slice(0, brand.length - 4); // partial, case-insensitive substring match

    await combo.fill(partial);
    await expect(combo).toHaveAttribute('aria-expanded', 'true');

    const listbox = page.locator('ul[role="listbox"]');
    await expect(listbox).toBeVisible();

    const matchOption = page.getByRole('option', { name: brand, exact: true });
    await expect(matchOption).toBeVisible();
    await matchOption.click();

    await expect(combo).toHaveValue(brand);
    await expect(listbox).not.toBeVisible();

    // Complete the rest of the form and submit — proves selection via the
    // combobox (not just .fill()) flows through to a real item.
    await inputByLabel(page, 'Size *').fill('L');
    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('12.00');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-01-11');
    await page.getByRole('button', { name: 'Add Clothing Item' }).click();
    await page.waitForURL('**/inventory');

    // Two items now share this brand (the setup one, size M, and this one,
    // size L) — scope the card match to the distinguishing size.
    await page.getByPlaceholder('Search title or author…').fill(brand);
    await expect(findItemCard(page, brand).filter({ hasText: 'Size L' })).toBeVisible();
  });

  test('BrandCombobox: typing a brand name that does not exist yet surfaces an "Add new brand" option, and selecting it creates the item', async ({ page }) => {
    await openClothingTab(page);
    const combo = page.getByRole('combobox', { name: /brand/i });
    const newBrand = `E2ENewBrand${uniqueSuffix()}`;

    await combo.fill(newBrand);
    const listbox = page.locator('ul[role="listbox"]');
    await expect(listbox).toBeVisible();

    const addNewOption = page.getByRole('option', { name: `Add "${newBrand}" as a new brand` });
    await expect(addNewOption).toBeVisible();
    await addNewOption.click();

    await expect(combo).toHaveValue(newBrand);
    await expect(listbox).not.toBeVisible();

    await inputByLabel(page, 'Size *').fill('S');
    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('7.50');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-01-12');
    await page.getByRole('button', { name: 'Add Clothing Item' }).click();
    await page.waitForURL('**/inventory');

    await page.getByPlaceholder('Search title or author…').fill(newBrand);
    await expect(findItemCard(page, newBrand)).toBeVisible();
  });

  test('BrandCombobox: keyboard-only ArrowDown then Enter selects the highlighted option, overriding the raw typed text', async ({ page }) => {
    const brand = `E2EKbBrand${uniqueSuffix()}`;
    await addClothing(page, { brand, size: 'M', cost: '5.00', date: '2026-01-10' });

    await openClothingTab(page);
    const combo = page.getByRole('combobox', { name: /brand/i });
    const partial = brand.slice(0, brand.length - 4);

    await combo.fill(partial);
    const listbox = page.locator('ul[role="listbox"]');
    await expect(listbox).toBeVisible();
    await expect(page.getByRole('option', { name: brand, exact: true })).toBeVisible();

    // The only canonical match plus an "add new" option are in the list;
    // one ArrowDown highlights the first (canonical) option.
    await combo.press('ArrowDown');
    await expect(combo).toHaveAttribute(
      'aria-activedescendant',
      /-option-0$/,
    );

    await combo.press('Enter');

    await expect(combo).toHaveValue(brand);
    expect(await combo.inputValue()).not.toBe(partial);
    await expect(listbox).not.toBeVisible();
  });

  test('BrandCombobox: Escape closes the dropdown without changing the input value', async ({ page }) => {
    await openClothingTab(page);
    const combo = page.getByRole('combobox', { name: /brand/i });
    const typed = `E2EEscBrand${uniqueSuffix()}`;

    await combo.fill(typed);
    const listbox = page.locator('ul[role="listbox"]');
    await expect(listbox).toBeVisible();

    await combo.press('Escape');

    await expect(listbox).not.toBeVisible();
    await expect(combo).toHaveAttribute('aria-expanded', 'false');
    await expect(combo).toHaveValue(typed);
  });

  test('SizeSystemPicker: defaults to Free text with a plain Size * text input', async ({ page }) => {
    await openClothingTab(page);

    await expect(inputByLabel(page, 'Size system')).toHaveValue('');
    const options = await inputByLabel(page, 'Size system').locator('option').allTextContents();
    expect(options).toEqual(['Free text', 'Letter (XS–XXL)', 'Shoe size', 'Numeric (waist × inseam)']);

    const sizeField = inputByLabel(page, 'Size *');
    await expect(sizeField).toBeVisible();
    expect(await sizeField.evaluate(el => el.tagName)).toBe('INPUT');
    expect(await sizeField.getAttribute('type')).toBe('text');

    // No waist/inseam fields in the default (free text) mode.
    await expect(page.locator('label', { hasText: 'Waist *' })).toHaveCount(0);
    await expect(page.locator('label', { hasText: 'Inseam *' })).toHaveCount(0);
  });

  test('SizeSystemPicker: selecting Letter (XS-XXL) swaps Size * to a closed-vocabulary select', async ({ page }) => {
    await openClothingTab(page);

    await inputByLabel(page, 'Size system').selectOption({ label: 'Letter (XS–XXL)' });

    const sizeField = inputByLabel(page, 'Size *');
    expect(await sizeField.evaluate(el => el.tagName)).toBe('SELECT');

    const options = await sizeField.locator('option').allTextContents();
    expect(options).toEqual(expect.arrayContaining(['XS', 'S', 'M', 'L', 'XL', 'XXL']));

    await sizeField.selectOption('M');
    await expect(sizeField).toHaveValue('M');
  });

  test('SizeSystemPicker: Numeric (waist x inseam) shows Waist */Inseam * number inputs and combines into size_label on submit', async ({ page }) => {
    const brand = `E2ENumericSize${uniqueSuffix()}`;
    await openClothingTab(page);

    await inputByLabel(page, 'Brand *').fill(brand);
    await inputByLabel(page, 'Size system').selectOption({ label: 'Numeric (waist × inseam)' });

    // The plain Size * field (text or select) is gone in numeric mode.
    await expect(page.locator('label', { hasText: 'Size *' })).toHaveCount(0);

    const waistField = inputByLabel(page, 'Waist *');
    const inseamField = inputByLabel(page, 'Inseam *');
    await expect(waistField).toBeVisible();
    await expect(inseamField).toBeVisible();
    expect(await waistField.getAttribute('type')).toBe('number');
    expect(await inseamField.getAttribute('type')).toBe('number');

    await waistField.fill('32');
    await inseamField.fill('34');

    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('9.00');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-01-25');
    await page.getByRole('button', { name: 'Add Clothing Item' }).click();
    await page.waitForURL('**/inventory');

    await openItemDetail(page, brand);
    expect(await detailValue(page, 'Size')).toBe('32x34');
  });

  test('SizeSystemPicker: switching systems clears a stale size value (no silent carryover)', async ({ page }) => {
    await openClothingTab(page);

    // Type a free-text size value under the default Free text system.
    await inputByLabel(page, 'Size *').fill('L');
    await expect(inputByLabel(page, 'Size *')).toHaveValue('L');

    // Switch to Letter (XS-XXL) — the prior "L" (which happens to also be a
    // valid letter option) must NOT carry over; the select should reset to
    // its own empty default, not silently inherit the stale text value.
    await inputByLabel(page, 'Size system').selectOption({ label: 'Letter (XS–XXL)' });
    const letterSelect = inputByLabel(page, 'Size *');
    expect(await letterSelect.evaluate(el => el.tagName)).toBe('SELECT');
    await expect(letterSelect).toHaveValue('');

    // Switch to Numeric (waist x inseam) — waist/inseam fields must start
    // blank, not carry over any prior value.
    await inputByLabel(page, 'Size system').selectOption({ label: 'Numeric (waist × inseam)' });
    await expect(inputByLabel(page, 'Waist *')).toHaveValue('');
    await expect(inputByLabel(page, 'Inseam *')).toHaveValue('');

    // Fill waist/inseam, then switch back to Free text — the Size * text
    // input must come back empty, not pre-filled with the derived "NxN".
    await inputByLabel(page, 'Waist *').fill('30');
    await inputByLabel(page, 'Inseam *').fill('32');
    await inputByLabel(page, 'Size system').selectOption({ label: 'Free text' });
    const freeTextField = inputByLabel(page, 'Size *');
    expect(await freeTextField.evaluate(el => el.tagName)).toBe('INPUT');
    await expect(freeTextField).toHaveValue('');
  });

  test('canonical brand persistence: a later submission with a different-case brand persists under the first-seen canonical casing', async ({ page }) => {
    const brand = `E2ECanon${uniqueSuffix()}`;
    await addClothing(page, { brand, size: 'M', cost: '5.00', date: '2026-01-15' });

    const brandVariant = brand.toUpperCase();
    expect(brandVariant).not.toBe(brand); // guarantees a genuinely different-case submission

    await addClothing(page, { brand: brandVariant, size: 'L', cost: '6.00', date: '2026-01-16' });

    // Two items now share the canonical brand. Note: the card's auto-generated
    // Listing Title is built client-side from whatever was typed, BEFORE the
    // server canonicalizes the brand on submit — so item B's card may still
    // display the uppercase variant. Match case-insensitively on the brand
    // (uniqueSuffix() is alphanumeric/hyphen, safe as a literal RegExp) and
    // scope by the distinguishing size to land on item B unambiguously.
    await page.getByPlaceholder('Search title or author…').fill(brand);
    const cardB = page.getByRole('link', { name: new RegExp(brand, 'i') }).filter({ hasText: 'Size L' });
    await expect(cardB).toBeVisible();
    await cardB.click();
    await page.waitForURL(/\/inventory\/[^/]+$/);

    // Item B's persisted Brand is the ORIGINAL casing (item A's, first-seen),
    // not the uppercase string actually typed for item B — proving
    // resolveCanonicalBrand's case-insensitive match-or-create persisted
    // through two real HTTP submissions.
    expect(await detailValue(page, 'Brand')).toBe(brand);
  });

  test('VocabCombobox (Color): typing a color name that does not exist yet surfaces an "Add new color" option, and selecting it creates the item', async ({ page }) => {
    await openClothingTab(page);
    const combo = page.getByRole('combobox', { name: /color/i });
    const newColor = `E2ENewColor${uniqueSuffix()}`;

    await combo.fill(newColor);
    const listbox = page.locator('ul[role="listbox"]');
    await expect(listbox).toBeVisible();

    const addNewOption = page.getByRole('option', { name: `Add "${newColor}" as a new Color` });
    await expect(addNewOption).toBeVisible();
    await addNewOption.click();

    await expect(combo).toHaveValue(newColor);
    await expect(listbox).not.toBeVisible();

    // Fill the remaining required fields and submit — proves the
    // color selected via the combobox (not just .fill()) flows through to a
    // real item, the same way the BrandCombobox "add new" test proves it for
    // brand.
    const brand = `E2EColorBrand${uniqueSuffix()}`;
    await inputByLabel(page, 'Brand *').fill(brand);
    await inputByLabel(page, 'Size *').fill('S');
    await inputByLabel(page, 'Acquisition Cost (USD) *').fill('7.50');
    await inputByLabel(page, 'Acquisition Date *').fill('2026-01-12');
    await page.getByRole('button', { name: 'Add Clothing Item' }).click();
    await page.waitForURL('**/inventory');

    await page.getByPlaceholder('Search title or author…').fill(brand);
    await expect(findItemCard(page, brand)).toBeVisible();
  });

  test('VocabCombobox (Color): case-variant resubmission of an existing color persists under the first-seen canonical casing (no duplicate canonical row)', async ({ page }) => {
    // Use a distinctive, genuinely new color (not one of the tenant's
    // pre-seeded colors) so there's no interference from seeded rows already
    // present in every tenant's vocabulary.
    const color = `E2ECanonColor${uniqueSuffix()}`;
    const brandA = `E2EColorCanonA${uniqueSuffix()}`;
    await addClothing(page, { brand: brandA, size: 'M', color, cost: '5.00', date: '2026-01-15' });

    const colorVariant = color.toUpperCase();
    expect(colorVariant).not.toBe(color); // guarantees a genuinely different-case submission

    const brandB = `E2EColorCanonB${uniqueSuffix()}`;
    await addClothing(page, { brand: brandB, size: 'L', color: colorVariant, cost: '6.00', date: '2026-01-16' });

    // Item B's persisted Color is the ORIGINAL casing (item A's, first-seen),
    // not the uppercase string actually typed for item B — proving the
    // shared canonical-vocabulary resolver (identical code path to
    // resolveCanonicalBrand) persisted through two real HTTP submissions.
    await openItemDetail(page, brandB);
    expect(await detailValue(page, 'Color')).toBe(color);
  });
});
