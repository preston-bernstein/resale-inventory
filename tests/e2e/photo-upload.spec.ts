import { test, expect, type Page } from '@playwright/test';
import { inputByLabel } from './helpers';

// Minimal valid 1x1 transparent PNG, used as upload fixture content — no
// real image asset needed.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function createClothingItem(page: Page, brand: string): Promise<void> {
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

// Navigates from /inventory to the detail page of the row whose title (or,
// for clothing, brand — the auto-suggested title always contains it)
// contains `needle`.
async function openDetailPage(page: Page, needle: string): Promise<void> {
  await page.goto('/inventory');
  await page.getByPlaceholder('Search title or author…').fill(needle);
  const row = page.locator('tr', { hasText: needle });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'View' }).click();
  await expect(page).toHaveURL(/\/inventory\/.+/);
}

test.describe('Photo upload (clothing items only)', () => {
  test('clothing detail page starts with "No photos yet."; book detail page has no Photos section at all', async ({ page }) => {
    const clothingBrand = `PhotoTestClothing-${suffix}`;
    const bookTitle = `PhotoTestBook-${suffix}`;

    await createClothingItem(page, clothingBrand);
    await openDetailPage(page, clothingBrand);

    await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
    await expect(page.getByText('No photos yet.')).toBeVisible();

    await createBookItem(page, bookTitle);
    await openDetailPage(page, bookTitle);

    await expect(page.getByRole('heading', { name: 'Photos' })).toHaveCount(0);
  });

  test('upload shows a thumbnail with reorder/delete controls, delete removes it, and a re-uploaded photo survives reload', async ({ page }) => {
    const clothingBrand = `PhotoTestUpload-${suffix}`;
    const pngBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');

    await createClothingItem(page, clothingBrand);
    await openDetailPage(page, clothingBrand);

    const photosSection = page.locator('section', { has: page.getByRole('heading', { name: 'Photos' }) });
    await expect(photosSection.getByText('No photos yet.')).toBeVisible();

    // Upload a photo.
    await photosSection.locator('input[type="file"]').setInputFiles({
      name: 'test.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    await photosSection.getByRole('button', { name: 'Upload' }).click();

    const thumbnail = photosSection.locator('img[src*="/photos/"]');
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

    const photosSectionAfterReload = page.locator('section', { has: page.getByRole('heading', { name: 'Photos' }) });
    await expect(photosSectionAfterReload.locator('img[src*="/photos/"]')).toBeVisible();
  });
});
