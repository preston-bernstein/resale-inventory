import '@testing-library/jest-dom/vitest';

// Re-exported so test suites can pull the tenant fixture from either this
// setup file or tests/helpers/tenant.ts directly (both resolve to the same
// module). See docs/reseller-multi-tenant-foundation/steps.md Step 3: every
// existing/future API test needs createTestTenant() once requireTenant()
// lands on routes.
export { createTestTenant } from './helpers/tenant';
export type { TestTenant } from './helpers/tenant';
