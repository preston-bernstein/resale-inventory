import path from 'path';

// Shared by playwright.config.ts (which must NOT import auth.setup.ts
// directly — that file calls Playwright's `setup(...)` test-registration
// function at module scope, which is only safe to evaluate inside the
// Playwright test runner's own module loading, not from config evaluation)
// and tests/e2e/auth.setup.ts itself.
export const STORAGE_STATE_PATH = path.resolve(__dirname, '../../.playwright-scratch/storageState.json');
