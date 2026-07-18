import type { FullConfig } from '@playwright/test';
import { startMockJwksServer, MOCK_JWKS_FIXED_E2E_PORT } from './fixtures/mockJwksServer';

// ---------------------------------------------------------------------------
// Playwright globalSetup, for tests/e2e/forward-auth.spec.ts.
//
// playwright.config.ts's webServer.env (which is what `next dev` actually
// boots with) is evaluated once, before any test file runs, and needs
// AUTHENTIK_JWKS_URL to already point at a live, listening mock JWKS
// endpoint -- but the mock server in tests/e2e/fixtures/mockJwksServer.ts
// normally binds an OS-assigned port that only exists once something calls
// startMockJwksServer(), i.e. too late for the config's static env block.
//
// globalSetup (unlike the `setup` *project*, which is itself a test that
// runs through the same webServer-already-running pipeline as every other
// spec) is documented by Playwright to run before webServer boots, in the
// same Node process as the rest of config evaluation -- exactly the timing
// this needs. Fix: start the mock server here, on a hardcoded port
// (MOCK_JWKS_FIXED_E2E_PORT) that playwright.config.ts's webServer.env can
// also reference statically, so by the time `next dev` starts and reads its
// env, the JWKS endpoint it's pointed at is already up.
//
// Returning an async function hands Playwright a teardown callback that
// runs after the whole test run finishes (same process, so the closed-over
// `server` reference is still valid) -- this is Playwright's documented
// alternative to a separate globalTeardown file/config entry, and is
// simpler here since there's only one thing to tear down.
// ---------------------------------------------------------------------------

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const server = await startMockJwksServer({ port: MOCK_JWKS_FIXED_E2E_PORT });

  return async () => {
    await server.stop();
  };
}
