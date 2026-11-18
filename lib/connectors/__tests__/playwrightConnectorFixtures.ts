import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { recordSuspensionSignal } from '@/lib/connections';

// Shared setup for the Playwright-driven connector suites (depop, poshmark).
// The suites that also spy on scrubSecrets use playwrightScrubSpyFixtures.ts.
// These suites never launch a real browser or import `playwright`. They mock
// withSession and validateSessionReadOnly, plus the lib/connections.ts
// functions the session module calls. recordSuspensionSignal lets suspension
// tests assert on it.
// Partial mock: keeps the real buildSessionHooks/fillClothingFields/
// uploadSortedPhotos (pure, no I/O, shared by every Playwright-driven
// connector) so wiring and category-field assertions still exercise real
// behavior. Only withSession/validateSessionReadOnly, the exports that touch
// playwright and credentials, stay mocked.
vi.mock('@/lib/connectors/playwrightSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/playwrightSession')>();
  return {
    ...actual,
    withSession: vi.fn(),
    validateSessionReadOnly: vi.fn(),
  };
});

vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
  getDecryptedCredential: vi.fn(),
  getConnection: vi.fn(),
  rotateCredential: vi.fn(),
}));

export const mockWithSession = withSession as unknown as Mock;

export const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;

export const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;
