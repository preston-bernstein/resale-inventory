import { test, expect } from '@playwright/test';

test.describe('Playbook page', () => {
  test('renders the workflow, platform table, and anchor nav', async ({ page }) => {
    await page.goto('/playbook');

    // --- 1. Heading and 17-step workflow ---
    await expect(page.getByRole('heading', { name: 'Seller Playbook' })).toBeVisible();

    const workflowSection = page.locator('section#workflow');
    await expect(workflowSection.getByRole('heading', { name: 'The 17-step workflow' })).toBeVisible();
    await expect(workflowSection.locator('ol > li')).toHaveCount(17);

    // --- 2. Platform table contains real platform names ---
    const platformSection = page.locator('section#platforms');
    const platformTable = platformSection.locator('table');
    await expect(platformTable).toContainText('Poshmark');
    await expect(platformTable).toContainText('Vinted');

    // --- 3. Anchor nav updates the URL hash ---
    await page.getByRole('link', { name: 'Shipping' }).click();
    await expect(page).toHaveURL(/#shipping$/);
  });
});

test.describe('Top navigation', () => {
  test('Inventory / Dashboard / Playbook / home links navigate correctly', async ({ page }) => {
    await page.goto('/inventory');

    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.getByRole('link', { name: 'Playbook', exact: true }).click();
    await expect(page).toHaveURL(/\/playbook$/);

    await page.getByRole('link', { name: 'Inventory', exact: true }).click();
    await expect(page).toHaveURL(/\/inventory$/);

    await page.getByRole('link', { name: 'Resale Inventory', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('root layout includes the PWA manifest link', async ({ page }) => {
    await page.goto('/inventory');
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
  });
});
