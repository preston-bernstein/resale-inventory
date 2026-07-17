import path from 'path';

// Mirrors tests/e2e/storageStatePath.ts's split-file rationale: shared by
// playwright.deployed.config.ts (which must NOT import authentik-auth.setup.ts
// directly — that file calls Playwright's `setup(...)` at module scope) and
// authentik-auth.setup.ts itself. Kept in its own .playwright-scratch subpath
// so a deployed run's cookies (real Authentik + real app session) never mix
// with the local suite's throwaway-tenant storageState.
export const DEPLOYED_STORAGE_STATE_PATH = path.resolve(
  __dirname,
  '../../.playwright-scratch/deployed-storageState.json',
);
