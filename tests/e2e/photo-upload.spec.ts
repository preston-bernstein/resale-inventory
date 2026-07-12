import { test, expect, type Page } from '@playwright/test';
import { inputByLabel, openItemDetail, createClothingItem } from './helpers';

// Minimal valid 1x1 transparent PNG, used as upload fixture content — no
// real image asset needed.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function createBookItem(page: Page, title: string): Promise<void> {
  await page.goto('/inventory/new');
  await page.getByRole('button', { name: 'Book', exact: true }).click();

  await inputByLabel(page, 'Title *').fill(title);
  await inputByLabel(page, 'Author *').fill('E2E Photo Test Author');
  // Condition * select defaults to "Good" — leave as-is.
  await inputByLabel(page, 'Acquisition Cost (USD) *').fill('5.00');
  await inputByLabel(page, 'Acquisition Date *').fill('2026-02-01');

  await page.getByRole('button', { name: 'Add Book' }).click();
  await expect(page).toHaveURL(/\/inventory$/);
}


test.describe('Photo upload (clothing items only)', () => {
  test('clothing detail page starts with "No photos yet."; book detail page has no Photos section at all', async ({ page }) => {
    const clothingBrand = `PhotoTestClothing-${suffix}`;
    const bookTitle = `PhotoTestBook-${suffix}`;

    await createClothingItem(page, clothingBrand);
    await openItemDetail(page, clothingBrand);

    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByText('No photos yet.')).toBeVisible();

    await createBookItem(page, bookTitle);
    await openItemDetail(page, bookTitle);

    await expect(page.getByRole('heading', { name: 'Photos' })).toHaveCount(0);
  });

  test('upload shows a thumbnail with reorder/delete controls, delete removes it, and a re-uploaded photo survives reload', async ({ page }) => {
    const clothingBrand = `PhotoTestUpload-${suffix}`;
    const pngBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');

    await createClothingItem(page, clothingBrand);
    await openItemDetail(page, clothingBrand);

    const photosSection = page.getByRole('heading', { name: 'Photos' }).locator('xpath=..');
    await expect(photosSection.getByText('No photos yet.')).toBeVisible();

    // Upload a photo.
    await photosSection.locator('input[type="file"]').setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    await photosSection.getByRole('button', { name: 'Upload' }).click();

    // Thumbnails render via next/image, which rewrites `src` through its
    // /_next/image optimization proxy with the original URL percent-encoded
    // in a `url=` query param — so match the encoded form, not a raw path.
    const thumbnail = photosSection.locator('img[src*="%2Fphotos%2F"]');
    await expect(thumbnail).toBeVisible();
    await expect(photosSection.getByText('No photos yet.')).toHaveCount(0);

    // Reorder/delete controls present on the thumbnail.
    await expect(photosSection.getByRole('button', { name: '↑' })).toBeVisible();
    await expect(photosSection.getByRole('button', { name: '↓' })).toBeVisible();
    await expect(photosSection.getByRole('button', { name: 'Delete' })).toBeVisible();

    // Delete it — thumbnail disappears, empty-state text returns.
    await photosSection.getByRole('button', { name: 'Delete' }).click();
    await expect(thumbnail).toHaveCount(0);
    await expect(photosSection.getByText('No photos yet.')).toBeVisible();

    // Re-upload, then reload the page — the photo must persist server-side,
    // not just in client state.
    await photosSection.locator('input[type="file"]').setInputFiles({
      name: 'test2.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    await photosSection.getByRole('button', { name: 'Upload' }).click();
    await expect(thumbnail).toBeVisible();

    await page.reload();

    const photosSectionAfterReload = page.getByRole('heading', { name: 'Photos' }).locator('xpath=..');
    await expect(photosSectionAfterReload.locator('img[src*="%2Fphotos%2F"]')).toBeVisible();
  });
});
