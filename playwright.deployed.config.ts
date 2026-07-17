import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { DEPLOYED_STORAGE_STATE_PATH } from './tests/e2e-deployed/deployedStorageStatePath';

// Separate config (not a project inside playwright.config.ts) because this
// suite drives an already-deployed instance — no webServer to boot, a
// different baseURL, and its own storageState/credentials — whereas the
// default config always spins up a local `next dev` against a throwaway
// scratch DB. Keeping them apart means `npm run test:e2e` can never
// accidentally point at production.
process.loadEnvFile(path.resolve(__dirname, '.env.deployed'));

const baseURL = process.env.QA_DEPLOYED_BASE_URL;
if (!baseURL) {
  throw new Error('QA_DEPLOYED_BASE_URL not set — see .env.deployed (gitignored, not committed)');
}

export default defineConfig({
  testDir: 'tests/e2e-deployed',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /authentik-auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: /authentik-auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: DEPLOYED_STORAGE_STATE_PATH },
      dependencies: ['setup'],
    },
  ],
  // Deliberately no `webServer` block — this config never starts a local
  // server, it only ever talks to QA_DEPLOYED_BASE_URL.
});
