import { test, expect, type Page } from '@playwright/test';
import { createClothingItem, openItemDetail } from './helpers';

// Minimal valid 1x1 transparent PNG, used as upload fixture content — no
// real image asset needed. Same fixture as photo-upload.spec.ts.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function createBookItem(page: Page, title: string): Promise<void> {
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Book', exact: true }).click();

  await page.locator('label', { hasText: 'Title *' }).locator('xpath=..').locator('input').fill(title);
  await page
    .locator('label', { hasText: 'Author *' })
    .locator('xpath=..')
    .locator('input')
    .fill('E2E Phone Handoff Test Author');
  await page
    .locator('label', { hasText: 'Acquisition Cost (USD) *' })
    .locator('xpath=..')
    .locator('input')
    .fill('5.00');
  await page
    .locator('label', { hasText: 'Acquisition Date *' })
    .locator('xpath=..')
    .locator('input')
    .fill('2026-02-01');

  await page.getByRole('button', { name: 'Add Book' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
}

test.describe('Phone handoff via QR code', () => {
  test('"Continue on phone" is present on clothing items, absent on books', async ({ page }) => {
    const clothingBrand = `PhoneHandoffGate-${suffix}`;
    const bookTitle = `PhoneHandoffGateBook-${suffix}`;

    await createClothingItem(page, clothingBrand);
    await openItemDetail(page, clothingBrand);
    await expect(page.getByRole('button', { name: 'Continue on phone' })).toBeVisible();

    await createBookItem(page, bookTitle);
    await openItemDetail(page, bookTitle);
    await expect(page.getByRole('button', { name: 'Continue on phone' })).toHaveCount(0);
  });

  test('full handoff: QR issuance, phone connects, phone uploads, desktop sees it live, end session invalidates the link', async ({
    page,
    context,
  }) => {
    const brand = `PhoneHandoffFlow-${suffix}`;
    await createClothingItem(page, brand);
    await openItemDetail(page, brand);

    // 1. Desktop issues a pairing token and QR.
    await page.getByRole('button', { name: 'Continue on phone' }).click();
    await expect(page.getByAltText('QR code to continue on phone')).toBeVisible();
    const phoneUrl = await page.locator('#phone-handoff-url').inputValue();
    expect(phoneUrl).toMatch(/^http:\/\/127\.0\.0\.1:3100\/phone\/[0-9a-f]{64}$/);

    // Desktop starts out "waiting" — the phone hasn't opened the link yet.
    await expect(page.getByText('Waiting for phone to scan…')).toBeVisible();

    // 2. A second tab simulates the phone scanning the QR code and opening
    // the link directly (this is exactly what a real phone camera app does
    // with a QR-encoded URL — no cross-device automation needed to exercise
    // the real server-side flow, since the token/URL round-trips through
    // the real API either way).
    const phonePage = await context.newPage();
    await phonePage.goto(phoneUrl);

    await expect(phonePage.getByRole('heading', { name: brand })).toBeVisible();
    // exact: true — the auto-generated clothing title itself contains
    // "Size M" as a substring, so a loose match here collides with it.
    await expect(phonePage.getByText('Size M', { exact: true })).toBeVisible();
    await expect(phonePage.getByText('Take / choose photos')).toBeVisible();
    // No site chrome on the phone route — components/SiteChrome.tsx hides it.
    await expect(phonePage.getByRole('link', { name: 'Resale Inventory' })).toHaveCount(0);
    await expect(phonePage.getByRole('link', { name: 'Inventory', exact: true })).toHaveCount(0);

    // 3. Desktop picks up the connection via polling, with no manual action.
    await expect(page.getByText('Phone connected')).toBeVisible({ timeout: 10_000 });

    // 4. Phone uploads a photo through the pairing-token-gated endpoint.
    const pngBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');
    await phonePage.locator('#phone-photo-input').setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    await phonePage.getByRole('button', { name: 'Upload' }).click();
    await expect(phonePage.getByText('1 photo(s) uploaded.')).toBeVisible();

    // 5. Desktop's next poll tick shows the new photo, without a reload.
    // .first() — the same uploaded photo renders both as the item's hero
    // image and again as its gallery thumbnail; either proves it arrived.
    await expect(page.locator('img[src*="%2Fphotos%2F"]').first()).toBeVisible({ timeout: 10_000 });

    // 6. Ending the session from the desktop invalidates the link
    // immediately — resets to idle, and the phone can no longer use it.
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Continue on phone' })).toBeVisible();

    await phonePage.reload();
    await expect(phonePage.getByText('This link is no longer valid.')).toBeVisible();
    // Nothing about the item survives an invalidated link.
    await expect(phonePage.getByRole('heading', { name: brand })).toHaveCount(0);

    await phonePage.close();
  });

  test('an unrecognized token shows the same generic error, never item data', async ({ page }) => {
    await page.goto(
      '/phone/0000000000000000000000000000000000000000000000000000000000000000',
    );
    await expect(page.getByText('This link is no longer valid.')).toBeVisible();
  });
});
