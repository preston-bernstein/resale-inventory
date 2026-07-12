import type { Page, Locator } from '@playwright/test';

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
export function fieldWrapper(scope: Page | Locator, labelText: string): Locator {
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
