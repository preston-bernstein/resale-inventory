import { test, expect, type Page, type Locator } from '@playwright/test';
import { inputByLabel, detailValue, uniqueSuffix } from './helpers';

interface NewBook {
  title: string;
  author: string;
  cost: string;
  date: string;
}

/** Fills and submits the Add Book form (Book tab is the default view). */
async function addBook(page: Page, book: NewBook): Promise<void> {
  await page.goto('/inventory/new');
  await expect(page.getByRole('heading', { name: 'Add Item' })).toBeVisible();

  await inputByLabel(page, 'Title *').fill(book.title);
  await inputByLabel(page, 'Author *').fill(book.author);
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill(book.cost);
  await inputByLabel(page, 'Acquisition Date *').fill(book.date);

  await page.getByRole('button', { name: 'Add Book' }).click();
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

test.describe('Book flow', () => {
  test('adding a book manually redirects to inventory and shows it in the table as Category Book', async ({ page }) => {
    const title = `E2E Book ${uniqueSuffix()}`;
    await addBook(page, { title, author: 'Jane Novelist', cost: '4.50', date: '2026-01-15' });

    expect(page.url()).toMatch(/\/inventory\/?$/);

    const row = await findRow(page, title);
    await expect(row).toContainText('Book');
  });

  test('book detail page, edit listing, and full status lifecycle to Sold', async ({ page }) => {
    const title = `E2E Book Lifecycle ${uniqueSuffix()}`;
    await addBook(page, { title, author: 'Marcus Reed', cost: '3.25', date: '2026-02-01' });

    await test.step('detail page shows correct Title/Author/Condition/Status', async () => {
      await openDetail(page, title);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      expect(await detailValue(page, 'Title')).toBe(title);
      expect(await detailValue(page, 'Author')).toBe('Marcus Reed');
      expect(await detailValue(page, 'Condition')).toBe('Good'); // AddBookForm default
      expect(await detailValue(page, 'Status')).toBe('Unlisted');
    });

    await test.step('a book item has no Photos section (clothing-only feature)', async () => {
      await expect(page.getByRole('heading', { name: 'Photos' })).toHaveCount(0);
    });

    await test.step('setting a Listing Price via Edit Listing saves and updates Details', async () => {
      await inputByLabel(page, 'Listing Price (USD)').fill('12.99');
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByText('Saved.')).toBeVisible();
      expect(await detailValue(page, 'Listing Price')).toBe('$12.99');
    });

    await test.step('Unlisted -> Listed transition', async () => {
      await inputByLabel(page, 'Transition to').selectOption('Listed');
      await page.getByRole('button', { name: 'Set to Listed' }).click();
      await expect(async () => {
        expect(await detailValue(page, 'Status')).toBe('Listed');
      }).toPass();
      // Not terminal: Edit Listing / Change Status sections remain.
      await expect(page.getByRole('heading', { name: 'Edit Listing' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Change Status' })).toBeVisible();
    });

    await test.step('Transition-to options change once status is Listed', async () => {
      const options = await inputByLabel(page, 'Transition to').locator('option').allTextContents();
      expect(options).toContain('Sale Pending');
      expect(options).not.toEqual(['Listed', 'Donated', 'Discarded']); // Unlisted's option set
    });

    await test.step('Listed -> Sale Pending -> Sold, verifying Price History and terminal state', async () => {
      await inputByLabel(page, 'Transition to').selectOption('Sale Pending');
      await page.getByRole('button', { name: 'Set to Sale Pending' }).click();
      await expect(async () => {
        expect(await detailValue(page, 'Status')).toBe('Sale Pending');
      }).toPass();

      await inputByLabel(page, 'Transition to').selectOption('Sold');
      await inputByLabel(page, 'Sale Price (USD)').fill('15.00');
      await inputByLabel(page, 'Sale Platform').selectOption('eBay');
      await inputByLabel(page, 'Sale Date').fill('2026-03-01');
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
