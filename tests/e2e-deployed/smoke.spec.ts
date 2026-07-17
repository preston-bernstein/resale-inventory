import { test, expect } from '@playwright/test';
import { createBookItem, findItemCard, uniqueSuffix } from '../e2e/helpers';

// ---------------------------------------------------------------------------
// Deployed-instance smoke suite. Intentionally minimal and mostly read-only:
// this drives the REAL production app on the desktop (real inventory.db,
// real photos/ storage) through the real Authentik + Cloudflare + Caddy
// chain — see resale-inventory-change-control's DB non-negotiables. The
// isolated `e2e-deployed-` tenant from authentik-auth.setup.ts keeps any
// writes here out of the operator's own tenant data, but nothing here
// should touch photo storage or external marketplace connector APIs — full
// CRUD/photo-upload/connector coverage stays in the local suite
// (playwright.config.ts) against the throwaway scratch DB, never here.
//
// Purpose: prove the deploy is actually reachable and working end-to-end
// (Authentik gate -> Cloudflare tunnel -> Caddy -> app -> app's own tenant
// auth -> real page render), not to re-run the full local regression suite
// against production.
// ---------------------------------------------------------------------------

test('dashboard loads for an authenticated tenant', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('connections page loads', async ({ page }) => {
  await page.goto('/connections');
  await expect(page).toHaveURL(/\/connections$/);
});

test('inventory add-item round trip works against the deployed instance', async ({ page }) => {
  const title = `E2E Deployed Smoke ${uniqueSuffix()}`;
  await createBookItem(page, { title });

  await page.goto('/inventory');
  await page.getByPlaceholder('Search title or author…').fill(title);
  await expect(findItemCard(page, title)).toBeVisible();
});
