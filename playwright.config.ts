import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// SAFETY: this MUST point at a throwaway DB file, never data/inventory.db —
// the operator's real, live inventory. This is the same non-negotiable
// safety rule that governs the vitest suite (see vitest.config.ts); the
// webServer below launches `npm run start` (a real, full Next.js server)
// with this env var set, so lib/db.ts's module-load side effect opens the
// scratch file instead of the real one. Never remove this, never override
// it to point at the real DB, even temporarily.
const e2eDbPath = path.resolve(__dirname, '.playwright-scratch/inventory.db');

// SAFETY: same reasoning as e2eDbPath above, for photo uploads — lib/photos.ts
// resolves its storage root from BOOKSELLER_PHOTOS_PATH, falling back to the
// operator's real data/photos/ tree when unset. photo-upload.spec.ts uploads
// real files; without this they'd land there instead of a scratch directory
// (discovered the hard way: an earlier E2E run left orphaned UUID
// directories under data/photos/ before this was wired in — cleaned up, not
// repeated).
const e2ePhotosPath = path.resolve(__dirname, '.playwright-scratch/photos');

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false, // single-user app, no auth — tests share one server/DB, avoid cross-test races
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Dev server (Turbopack), not a production build: starts in ~1s instead
    // of paying a full `next build` on every local E2E run, and — per this
    // repo's own documented finding — `next build` against a brand-new,
    // not-yet-migrated scratch DB can race across build workers; `next dev`
    // is a single process, sidestepping that entirely. CI can layer a
    // separate build-then-start job on top of this config if it ever needs
    // to test the production bundle specifically.
    command: 'next dev --turbopack -H 127.0.0.1 -p 3100',
    url: 'http://127.0.0.1:3100/inventory',
    reuseExistingServer: false, // always fresh — a stale server could be pointed at a different DB
    timeout: 60_000,
    env: {
      BOOKSELLER_DB_PATH: e2eDbPath,
      BOOKSELLER_PHOTOS_PATH: e2ePhotosPath,
    },
  },
});
