import { test, expect } from '@playwright/test';
import { createBookItem, findItemCard, uniqueSuffix } from './helpers';
import { STORAGE_STATE_PATH } from './storageStatePath';

// ---------------------------------------------------------------------------
// Login/signup page UX coverage (FR29). auth.setup.ts bootstraps the REST of
// this suite by calling /api/auth/signup directly via `request` — it never
// drives app/login/page.tsx or app/signup/page.tsx through a real browser,
// so the actual form fields, redirect, and inline-error rendering have never
// been exercised end-to-end. This file fills that gap.
//
// Unlike every other spec in this suite, these tests must run UNAUTHENTICATED
// — the `chromium` project in playwright.config.ts otherwise loads the
// shared E2E tenant's storageState for every test. Overriding storageState
// to an empty state here means each test starts with a clean cookie jar.
//
// Unlike the rest of the app's forms (see helpers.ts's fieldWrapper note),
// these two pages use a real `<label htmlFor>`/`id` association, so
// page.getByLabel(...) resolves them directly — no fieldWrapper needed.
// ---------------------------------------------------------------------------

test.use({ storageState: { cookies: [], origins: [] } });

const SESSION_COOKIE_NAME = 'reseller_session';

async function getSessionCookie(page: import('@playwright/test').Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === SESSION_COOKIE_NAME);
}

test.describe('Signup page', () => {
  test('happy path: signing up redirects to /inventory and sets a session cookie', async ({ page }) => {
    const email = `e2e-signup-${uniqueSuffix()}@example.invalid`;
    const password = 'a-reasonably-strong-password';

    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible();

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();

    await page.waitForURL('**/inventory');
    await expect(page).toHaveURL(/\/inventory$/);

    const cookie = await getSessionCookie(page);
    expect(cookie).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
  });

  test('failure: duplicate email shows an inline error, no redirect, no session cookie', async ({ page }) => {
    const email = `e2e-signup-dup-${uniqueSuffix()}@example.invalid`;
    const password = 'a-reasonably-strong-password';

    // First signup succeeds and establishes the session cookie.
    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.waitForURL('**/inventory');
    const firstCookie = await getSessionCookie(page);
    expect(firstCookie).toBeTruthy();

    // Clear cookies to simulate a fresh, unauthenticated attempt at the same
    // email — otherwise the second visit to /signup would itself redirect
    // away as an already-authenticated tenant.
    await page.context().clearCookies();

    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();

    // Next.js's own route announcer (#__next-route-announcer__) also carries
    // role="alert", so scope to the <p> the page itself renders rather than
    // matching role alone.
    const signupAlert = page.locator('p[role="alert"]');
    await expect(signupAlert).toBeVisible();
    await expect(signupAlert).toContainText('already registered');
    await expect(page).toHaveURL(/\/signup$/);

    const cookieAfterFailure = await getSessionCookie(page);
    expect(cookieAfterFailure).toBeUndefined();
  });
});

test.describe('Login page', () => {
  test('happy path: logging in with valid credentials redirects to /inventory and sets a session cookie', async ({ page }) => {
    const email = `e2e-login-${uniqueSuffix()}@example.invalid`;
    const password = 'a-reasonably-strong-password';

    // Sign up first (via the API directly, matching auth.setup.ts's own
    // convention) so this test only exercises the login page itself.
    const signupRes = await page.request.post('/api/auth/signup', { data: { email, password } });
    expect(signupRes.ok()).toBe(true);
    await page.context().clearCookies();

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();

    await page.waitForURL('**/inventory');
    await expect(page).toHaveURL(/\/inventory$/);

    const cookie = await getSessionCookie(page);
    expect(cookie).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
  });

  test('failure: wrong password shows an inline error, no redirect, no session cookie', async ({ page }) => {
    const email = `e2e-login-bad-${uniqueSuffix()}@example.invalid`;
    const password = 'a-reasonably-strong-password';

    const signupRes = await page.request.post('/api/auth/signup', { data: { email, password } });
    expect(signupRes.ok()).toBe(true);
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Log in' }).click();

    // See the signup test above for why this scopes to `p[role="alert"]`
    // instead of matching role="alert" alone.
    const loginAlert = page.locator('p[role="alert"]');
    await expect(loginAlert).toBeVisible();
    await expect(loginAlert).toContainText('Invalid email or password');
    await expect(page).toHaveURL(/\/login$/);

    const cookie = await getSessionCookie(page);
    expect(cookie).toBeUndefined();
  });
});

test.describe('Session persistence (authenticated)', () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test('session survives navigation and reload after item creation', async ({ page }) => {
    const title = `SessionPersistTest-${uniqueSuffix()}`;
    await createBookItem(page, { title });

    await page.goto('/dashboard');
    await page.reload();

    await expect(page).not.toHaveURL(/\/login$/);
    const cookie = await getSessionCookie(page);
    expect(cookie).toBeTruthy();

    await page.goto('/inventory');
    await page.getByPlaceholder('Search title or author…').fill(title);
    await expect(findItemCard(page, title)).toBeVisible();
  });
});
