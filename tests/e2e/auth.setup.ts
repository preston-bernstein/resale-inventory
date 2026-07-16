import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { STORAGE_STATE_PATH } from './storageStatePath';

// ---------------------------------------------------------------------------
// E2E auth bootstrap (Task 22 retrofit). Every page in this app now sits
// behind tenant auth (requireTenant() on API routes; app/dashboard/page.tsx
// additionally redirects server-side to /login with no session). The rest of
// this E2E suite predates multi-tenancy and drives the app as an
// unauthenticated browser — none of those specs know how to log in, and
// retrofitting each one individually would duplicate the same signup dance
// everywhere.
//
// Instead, following Playwright's documented "setup project" pattern: this
// project runs once before every other test, signs up a single throwaway
// tenant against the already-running webServer, and saves the resulting
// session cookie to a storageState file. playwright.config.ts's `chromium`
// project then loads that storageState for every test, so every `page` (and
// every `page.request.*` call, which shares the browsing context's cookie
// jar) is already authenticated as that one tenant — the same "no fullyParallel,
// one shared server/DB" model this suite already uses, just now with one
// shared tenant identity instead of none.
// ---------------------------------------------------------------------------

setup('authenticate as a single E2E tenant', async ({ request }) => {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.invalid`;
  const password = 'e2e-suite-test-password';

  const res = await request.post('/api/auth/signup', {
    data: { email, password },
  });
  expect(res.ok(), `signup failed: ${res.status()} ${await res.text()}`).toBe(true);

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await request.storageState({ path: STORAGE_STATE_PATH });
});
