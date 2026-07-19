import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { STORAGE_STATE_PATH } from './tests/e2e/storageStatePath';
import {
  MOCK_JWKS_FIXED_E2E_PORT,
  MOCK_AUTHENTIK_ISSUER,
  MOCK_AUTHENTIK_AUDIENCE,
} from './tests/e2e/fixtures/mockJwksServer';

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

// SAFETY: same reasoning as e2eDbPath/e2ePhotosPath above, for the
// credential-encryption master key — lib/credentialCrypto.ts resolves its
// key file from BOOKSELLER_CREDENTIAL_KEY_PATH, falling back to the
// operator's real data/credential.key otherwise. Without this, an E2E run
// touching credential-backed flows would generate/read the real key file.
const e2eCredentialKeyPath = path.resolve(__dirname, '.playwright-scratch/credential.key');

export default defineConfig({
  testDir: 'tests/e2e',
  // Starts the mock Authentik JWKS server (tests/e2e/forward-auth.spec.ts)
  // on a fixed port BEFORE webServer below boots -- see tests/e2e/globalSetup.ts
  // for why this can't just be started from inside the spec file. Returns
  // its own teardown callback, so no separate globalTeardown entry is needed.
  globalSetup: require.resolve('./tests/e2e/globalSetup'),
  fullyParallel: false, // tests share one server/DB (and, since Task 22, one E2E tenant) — avoid cross-test races
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
    // Task 22 retrofit: runs once before every other test, signs up a
    // single throwaway E2E tenant against the running webServer, and saves
    // its session cookie to STORAGE_STATE_PATH — see tests/e2e/auth.setup.ts
    // for why this is necessary now that every route sits behind tenant
    // auth. `dependencies: ['setup']` on the `chromium` project guarantees
    // this always runs first, exactly once, before any real spec.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE_PATH },
      dependencies: ['setup'],
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
      BOOKSELLER_CREDENTIAL_KEY_PATH: e2eCredentialKeyPath,
      // Lets phone-handoff.spec.ts exercise the real QR-issuance happy path
      // instead of only the "origin undetermined" 409 case: lib/tailnetOrigin.ts
      // accepts a Host that exactly matches this URL's hostname as an
      // explicit operator override, bypassing the *.ts.net requirement — see
      // that file's PUBLIC_ORIGIN handling. Scoped to this webServer process
      // only, same isolation pattern as BOOKSELLER_DB_PATH above; never set
      // on the real app.
      PUBLIC_ORIGIN: 'http://127.0.0.1:3100',
      // Forward-auth (Authentik) E2E coverage (tests/e2e/forward-auth.spec.ts):
      // points the app at the mock JWKS server that globalSetup above starts
      // on MOCK_JWKS_FIXED_E2E_PORT, so lib/forwardAuth.ts's module-load
      // config is populated by the time `next dev` boots. This is a plain
      // http:// URL on 127.0.0.1 -- lib/forwardAuth.ts only allows that
      // combination outside NODE_ENV=production, which `next dev` here is.
      AUTHENTIK_JWKS_URL: `http://127.0.0.1:${MOCK_JWKS_FIXED_E2E_PORT}/jwks`,
      AUTHENTIK_ISSUER: MOCK_AUTHENTIK_ISSUER,
      AUTHENTIK_AUDIENCE: MOCK_AUTHENTIK_AUDIENCE,
    },
  },
});
