import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { enforcePacing } from '@/lib/connectors/pacing';
import type { ListingInput } from '@/lib/connectors/types';
import {
  buildBookInput,
  buildClothingInput,
  buildElectronicsInput,
  makeFakePageWith,
  wireSessionTo,
} from './playwrightListingBuilders';
import { mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';

// This suite mocks playwrightSession.ts's withSession/validateSessionReadOnly
// and pacing.ts's enforcePacing wholesale -- it never launches a real
// browser or imports `playwright`, and never exercises the real in-memory
// rate-limit bucket (that's pacing.test.ts's job). It also mocks
// lib/connections.ts#recordSuspensionSignal so the suspension-classification
// tests can assert on it directly.
// Partial mock: keeps the real buildSessionHooks/fillClothingFields (pure,
// no I/O -- shared by every Playwright-driven connector, see
// playwrightSession.ts) so this file's wiring/category-field assertions
// still exercise real behavior, while withSession/validateSessionReadOnly
// (the only exports that touch playwright/credentials) stay mocked.
vi.mock('@/lib/connectors/pacing', () => ({
  enforcePacing: vi.fn(),
}));

export const mockEnforcePacing = enforcePacing as unknown as Mock;

export let realScrubSecrets: (typeof import('@/lib/connectors/scrub'))['scrubSecrets'];

export function buildListingInput(connectionId: string, itemId: string): ListingInput {
  return buildClothingInput(connectionId, itemId, { title: 'Test Jacket', priceCents: 12000, color: 'Black' });
}

// Fake Playwright `Page` -- only used directly by the suspension-
// classification tests below, which invoke the SessionHooks#validateSession
// hook this file builds (captured from a mocked withSession/
// validateSessionReadOnly call) against it, simulating what
// playwrightSession.ts's real (non-mocked) implementation would pass in.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => 'https://www.grailed.com/listings/123456-test-jacket', isVisible: false }, overrides);
}

/** Builds a book ListingInput -- buildListingInput() above is clothing-only. */
export function buildBookListingInput(connectionId: string, itemId: string): ListingInput {
  return buildBookInput(connectionId, itemId);
}

/** Builds an electronics ListingInput -- buildListingInput() above is clothing-only. */
export function buildElectronicsListingInput(connectionId: string, itemId: string): ListingInput {
  return buildElectronicsInput(connectionId, itemId);
}

/**
 * Wires the mocked withSession to actually invoke the callback passed to
 * it (the real createListingAction/updateListingAction/markSoldAction/
 * delistAction closures) against `page` -- rather than just recording that
 * withSession was called. This is what lets the tests below exercise the
 * real Playwright-interaction code (navigation, fills, id extraction) that
 * the rest of this file deliberately never reaches.
 */
export function wireRealSession(page: ReturnType<typeof makeFakePage>) {
  wireSessionTo(mockWithSession, page);
}

export const beforeAllGrailed = async () => {
  const actual = await vi.importActual<typeof import('@/lib/connectors/scrub')>('@/lib/connectors/scrub');
  realScrubSecrets = actual.scrubSecrets;
};

export const beforeEachGrailed = () => {
  // resetAllMocks (not just clearAllMocks) so a mockImplementation set by
  // one test's enforcePacing-throws scenario doesn't leak its throwing
  // behavior into the next test -- each test starts with a fresh, no-op
  // mock implementation. scrubSecrets is the one exception -- restore its
  // real passthrough implementation immediately after, since
  // resetAllMocks strips that too and several tests need the real
  // scrubbing behavior.
  vi.resetAllMocks();
  mockScrubSecrets.mockImplementation(realScrubSecrets);
};

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';
