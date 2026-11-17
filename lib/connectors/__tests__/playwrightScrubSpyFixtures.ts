import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { recordSuspensionSignal } from '@/lib/connections';
import { scrubSecrets } from '@/lib/connectors/scrub';

// Shared setup for the Playwright-driven connector suites that also spy on
// scrubSecrets (grailed, mercari, swappa, vinted). The others use
// playwrightConnectorFixtures.ts. The two files stay apart because vitest
// applies a mock only when it sits in the same module as the mock of the
// session module that loads the mocked module.
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

// Partial mock: keeps scrubSecrets' real implementation available (restore it
// after every vi.resetAllMocks(), which strips a vi.fn's implementation along
// with its call history) while still letting tests assert on the exact args
// it was called with. That kills the mutant that swaps the empty secrets array
// literal for a non-empty one.
vi.mock('@/lib/connectors/scrub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/scrub')>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
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

export const mockScrubSecrets = scrubSecrets as unknown as Mock;
