import { test, expect, type Page } from '@playwright/test';
import {
  inputByLabel,
  detailValue,
  uniqueSuffix,
  findItemCard,
  openItemDetail,
  createBookItem,
  saveListingPrice,
  transitionTo,
  markSold,
  expectTerminalSoldState,
} from './itemFlows';

async function expectDetailValues(page: Page, title: string) {
  await openItemDetail(page, title);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect(await detailValue(page, 'Title')).toBe(title);
  expect(await detailValue(page, 'Author')).toBe('Marcus Reed');
  expect(await detailValue(page, 'Condition')).toBe('Good'); // AddBookForm default
  expect(await detailValue(page, 'Status')).toBe('Unlisted');
}

test.describe('Book flow', () => {
  test('adding a book manually redirects to inventory and shows it as Category Book', async ({ page }) => {
    const title = `E2E Book ${uniqueSuffix()}`;
    await createBookItem(page, { title, author: 'Jane Novelist', cost: '4.50', date: '2026-01-15' });

    expect(page.url()).toMatch(/\/inventory\/?$/);

    await page.getByPlaceholder('Search title or author…').fill(title);
    const card = findItemCard(page, title);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Book');
  });

  test('book detail page, edit listing, and full status lifecycle to Sold', async ({ page }) => {
    const title = `E2E Book Lifecycle ${uniqueSuffix()}`;
    await createBookItem(page, { title, author: 'Marcus Reed', cost: '3.25', date: '2026-02-01' });

    await test.step('detail page shows correct Title/Author/Condition/Status', () =>
      expectDetailValues(page, title));

    await test.step('a book item has no Photos section (clothing-only feature)', async () => {
      await expect(page.getByRole('heading', { name: 'Photos' })).toHaveCount(0);
    });

    await test.step('setting a Listing Price via Edit Listing saves and updates Details', async () => {
      await saveListingPrice(page, '12.99');
      expect(await detailValue(page, 'Listing Price')).toBe('$12.99');
    });

    await test.step('Unlisted -> Listed transition', async () => {
      await transitionTo(page, 'Listed');
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
      await transitionTo(page, 'Sale Pending');
      await markSold(page, { price: '15.00', platform: 'eBay', date: '2026-03-01' });
      await expectTerminalSoldState(page);
    });
  });
});

test.describe('Book flow — no Size field', () => {
  test('AddBookForm never renders a Size field, and none appears on the resulting detail page', async ({ page }) => {
    await test.step('Add Item form, Book tab active: no Size field anywhere', async () => {
      await page.goto('/inventory/new');
      await page.getByRole('button', { name: 'Book', exact: true }).click();
      await expect(page.getByText('Size *')).toHaveCount(0);
      await expect(page.locator('label', { hasText: 'Size' })).toHaveCount(0);
    });

    const title = `E2E No Size ${uniqueSuffix()}`;
    await createBookItem(page, { title, author: 'No Size Author', cost: '2.00', date: '2026-01-05' });

    await test.step('detail page Details section: no Size field', async () => {
      await openItemDetail(page, title);
      await expect(page.locator('span:text-is("Size")')).toHaveCount(0);
    });
  });
});
