import { expect, type Page, type Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Locator helpers
//
// NOTE: this app's form fields render a bare `<label>` immediately before
// the `<input>`/`<select>`, as siblings inside a shared wrapper `<div>` —
// there is no `for`/`id` association and the label does not wrap the
// control. That means `page.getByLabel(...)` cannot resolve these fields
// (Playwright's accessible-name algorithm requires one of those two
// associations).
// ---------------------------------------------------------------------------

/**
 * The immediate parent element of the `<label>` whose text includes
 * `labelText` — i.e. the field's own wrapper, not any ancestor container.
 * `scope.locator('div').filter({ has: label })` was tried first but matches
 * every ancestor div that merely contains the label as a descendant
 * (including the whole form's outer wrapper div), so `.first()`/`.last()`
 * on that result is unreliable — it silently resolved to the first input in
 * the *entire form* regardless of which label was searched for. Walking up
 * from the label itself is unambiguous.
 */
function fieldWrapper(scope: Page | Locator, labelText: string): Locator {
  return scope.locator('label', { hasText: labelText }).locator('xpath=..');
}

/** The input/select/textarea inside the field wrapper for `labelText`. */
export function inputByLabel(scope: Page | Locator, labelText: string): Locator {
  return fieldWrapper(scope, labelText).locator('input, select, textarea').first();
}

/**
 * Item detail page "Details" section renders each field as
 * `<div class="flex gap-2"><span>{label}</span><span>{value}</span></div>`.
 * Find the value span immediately following the exact-text label span.
 */
export async function detailValue(page: Page, label: string): Promise<string> {
  const value = page.locator(`span:text-is("${label}")`).locator('xpath=following-sibling::span[1]');
  return ((await value.textContent()) ?? '').trim();
}

export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The inventory list renders as a photo-forward card grid (not a table) —
 * each item is one big `<Link>` wrapping a photo, badges, title, condition,
 * and price, so its Playwright accessible name is the concatenation of all
 * of that text. Matching on just the title (as a substring) is still
 * unambiguous since titles are unique per test fixture.
 */
export function findItemCard(page: Page, title: string): Locator {
  return page.getByRole('link', { name: new RegExp(escapeRegExp(title)) });
}

/** Navigates from /inventory to an item's detail page by clicking its card. */
export async function openItemDetail(page: Page, title: string): Promise<void> {
  await page.goto('/inventory');
  await page.getByPlaceholder('Search title or author…').fill(title);
  await findItemCard(page, title).click();
  await page.waitForURL(/\/inventory\/[^/]+$/);
}

/** Creates a clothing item via the /inventory/new form, ending back on /inventory. */
export async function createClothingItem(page: Page, brand: string): Promise<void> {
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Clothing', exact: true }).click();

  await inputByLabel(page, 'Brand *').fill(brand);
  await inputByLabel(page, 'Size *').fill('M');
  // Condition * select defaults to "EUC" — leave as-is.
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill('25.00');
  await inputByLabel(page, 'Acquisition Date *').fill('2026-02-01');

  await page.getByRole('button', { name: 'Add Clothing Item' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
}

/** Creates a book item via the /inventory/new form, ending back on /inventory. */
export async function createBookItem(
  page: Page,
  book: { title: string; author?: string; cost?: string; date?: string },
): Promise<void> {
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Book', exact: true }).click();

  await inputByLabel(page, 'Title *').fill(book.title);
  await inputByLabel(page, 'Author *').fill(book.author ?? `E2E Author ${uniqueSuffix()}`);
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill(book.cost ?? '9.99');
  await inputByLabel(page, 'Acquisition Date *').fill(book.date ?? '2026-01-15');

  await page.getByRole('button', { name: 'Add Book' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
}

/** Fills the Listing Price on the detail page and saves it. */
export async function saveListingPrice(page: Page, price: string): Promise<void> {
  await inputByLabel(page, 'Listing Price (USD)').fill(price);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
}

async function expectStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    expect(await detailValue(page, 'Status')).toBe(status);
  }).toPass();
}

/** Moves the item to `status` through the Change Status form and waits for it to show. */
export async function transitionTo(page: Page, status: string): Promise<void> {
  await inputByLabel(page, 'Transition to').selectOption(status);
  await page.getByRole('button', { name: `Set to ${status}` }).click();
  await expectStatus(page, status);
}

/** Moves a Sale Pending item to Sold with the given sale details. */
export async function markSold(
  page: Page,
  sale: { price: string; platform: string; date: string },
): Promise<void> {
  await inputByLabel(page, 'Transition to').selectOption('Sold');
  await inputByLabel(page, 'Sale Price (USD)').fill(sale.price);
  await inputByLabel(page, 'Sale Platform').selectOption(sale.platform);
  await inputByLabel(page, 'Sale Date').fill(sale.date);
  await page.getByRole('button', { name: 'Set to Sold' }).click();
  await expectStatus(page, 'Sold');
}

/** A sold item shows its price history and no longer offers Edit Listing or Change Status. */
export async function expectTerminalSoldState(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Price History' })).toBeVisible();
  const historyRows = page.locator('table', { has: page.getByRole('columnheader', { name: 'Previous' }) }).locator('tbody tr');
  await expect(historyRows).not.toHaveCount(0);

  // Terminal state: Edit Listing / Change Status sections are gone.
  await expect(page.getByRole('heading', { name: 'Edit Listing' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Change Status' })).toHaveCount(0);
}

// Minimal valid 1x1 transparent PNG, used as upload fixture content — no
// real image asset needed.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A `setInputFiles` payload holding the tiny PNG under `name`. */
export function tinyPngFile(name: string) {
  return { name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_BASE64, 'base64') };
}
