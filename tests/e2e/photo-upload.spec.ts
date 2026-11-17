import { test, expect, type Locator } from '@playwright/test';
import { openItemDetail, createClothingItem, createBookItem, tinyPngUpload } from './inventoryPage';

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function uploadPhoto(photosSection: Locator, fileName: string) {
  await photosSection.locator('input[type="file"]').setInputFiles(tinyPngUpload(fileName));
  await photosSection.getByRole('button', { name: 'Upload' }).click();
}

test.describe('Photo upload (clothing items only)', () => {
  test('clothing detail page starts with "No photos yet."; book detail page has no Photos section at all', async ({ page }) => {
    const clothingBrand = `PhotoTestClothing-${suffix}`;
    const bookTitle = `PhotoTestBook-${suffix}`;

    await createClothingItem(page, clothingBrand);
    await openItemDetail(page, clothingBrand);

    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByText('No photos yet.')).toBeVisible();

    await createBookItem(page, { title: bookTitle });
    await openItemDetail(page, bookTitle);

    await expect(page.getByRole('heading', { name: 'Photos' })).toHaveCount(0);
  });
});

test.describe('Photo upload (clothing items only)', () => {
  test('upload shows a thumbnail with reorder/delete controls, delete removes it, and a re-uploaded photo survives reload', async ({ page }) => {
    const clothingBrand = `PhotoTestUpload-${suffix}`;

    await createClothingItem(page, clothingBrand);
    await openItemDetail(page, clothingBrand);

    const photosSection = page.getByRole('heading', { name: 'Photos' }).locator('xpath=..');
    await expect(photosSection.getByText('No photos yet.')).toBeVisible();

    // Upload a photo.
    await uploadPhoto(photosSection, 'test.png');

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
    await uploadPhoto(photosSection, 'test2.png');
    await expect(thumbnail).toBeVisible();

    await page.reload();

    const photosSectionAfterReload = page.getByRole('heading', { name: 'Photos' }).locator('xpath=..');
    await expect(photosSectionAfterReload.locator('img[src*="%2Fphotos%2F"]')).toBeVisible();
  });
});
