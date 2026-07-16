import crypto from 'crypto';
import { createTenant, createSession, MIN_PASSWORD_LENGTH } from '@/lib/tenantAuth';
import { SESSION_COOKIE_NAME } from '@/lib/constants';

// A fixed password used for every test tenant -- length only needs to clear
// lib/tenantAuth.ts's MIN_PASSWORD_LENGTH floor; no test exercises password
// strength via this fixture (lib/tenantAuth.test.ts, once it exists, is
// where that floor itself gets tested).
const TEST_PASSWORD = 'test-tenant-password'; // 21 chars, well past the floor.

if (TEST_PASSWORD.length < MIN_PASSWORD_LENGTH) {
  // Defensive: if MIN_PASSWORD_LENGTH is ever raised past this literal,
  // fail loudly at import time instead of every createTestTenant() call
  // throwing WeakPasswordError for a confusing reason.
  throw new Error(
    `tests/helpers/tenant.ts TEST_PASSWORD (${TEST_PASSWORD.length} chars) is shorter than ` +
      `lib/tenantAuth.ts MIN_PASSWORD_LENGTH (${MIN_PASSWORD_LENGTH}); update TEST_PASSWORD.`,
  );
}

export interface TestTenant {
  /** The created tenant's id, as returned by lib/tenantAuth.ts's createTenant(). */
  tenantId: string;
  /** The raw session token (as issued by lib/tenantAuth.ts's createSession()). */
  token: string;
  /** Ready-to-use `Cookie` header value for HTTP test requests. */
  cookieHeader: string;
}

/**
 * Create a fresh tenant + session for use in tests, calling into
 * lib/tenantAuth.ts directly rather than reimplementing any auth logic.
 *
 * Generates a unique email per call (`test-<uuid>@example.invalid`) --
 * REQUIRED, not cosmetic: tenants.email is UNIQUE and the whole test suite
 * shares one scratch DB with vitest.config.ts's `fileParallelism: false`, so
 * a fixed/predictable email would collide across test files sharing that DB.
 */
export function createTestTenant(): TestTenant {
  const email = `test-${crypto.randomUUID()}@example.invalid`;
  const { tenantId } = createTenant(email, TEST_PASSWORD);
  const { token } = createSession(tenantId);

  return {
    tenantId,
    token,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}
