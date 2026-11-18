import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ListingInput } from '@/lib/connectors/types';
import { enforcePacing } from '@/lib/connectors/pacing';
import {
  buildBookInput,
  buildClothingInput,
  makeFakePageWith,
  wireSessionTo,
} from './playwrightListingBuilders';
import { mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';

// This suite mocks the shared Playwright session module
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// lib/rateLimit.ts fixed-window bucket (that's pacing.test.ts's job). It
// also mocks lib/connections.ts#recordSuspensionSignal so the
// suspension-classification tests can assert on it directly. Unlike
// poshmark.test.ts, there's no persistence-layer describe block here --
// Vinted has no durable cooldown/share-cap tables to seed against a real
// scratch DB; enforcePacing is its entire ban-risk mitigation story, and
// that's a pure mock in this file.
// Partial mock: keeps the real buildSessionHooks/fillClothingFields/
// uploadSortedPhotos (pure, no I/O -- shared by every Playwright-driven
// connector, see playwrightSession.ts) so this file's wiring/category-
// field/photo-upload assertions still exercise real behavior, while
// withSession/validateSessionReadOnly (the only exports that touch
// playwright/credentials) stay mocked.
vi.mock('@/lib/connectors/pacing', () => ({
  enforcePacing: vi.fn(),
}));

export const mockEnforcePacing = enforcePacing as unknown as Mock;

export let realScrubSecrets: (typeof import('@/lib/connectors/scrub'))['scrubSecrets'];

export const CONNECTION_ID = 'vinted-conn-1';

export const ITEM_ID = 'vinted-item-1';

export const EXTERNAL_LISTING_ID = 'VINTED-LISTING-1';

export function buildListingInput(): ListingInput {
  return buildClothingInput(CONNECTION_ID, ITEM_ID, { title: 'Test Jacket', priceCents: 4500, color: 'Blue' });
}

// Fake Playwright `Page` -- only used directly by the suspension-
// classification tests below, which invoke the SessionHooks#validateSession
// hook this file builds (captured from a mocked withSession/
// validateSessionReadOnly call) against it, simulating what
// playwrightSession.ts's real (non-mocked) implementation would pass in.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => `https://www.vinted.com/items/${EXTERNAL_LISTING_ID}`, isVisible: false }, overrides);
}

/** Builds a book ListingInput -- buildListingInput() above is clothing-only. */
export function buildBookListingInput(): ListingInput {
  return buildBookInput(CONNECTION_ID, 'vinted-book-item-1');
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

export const beforeAllVintedPlaywrightAction = async () => {
  const actual = await vi.importActual<typeof import('@/lib/connectors/scrub')>('@/lib/connectors/scrub');
  realScrubSecrets = actual.scrubSecrets;
};

export const beforeEachVintedPlaywrightAction = () => {
  // resetAllMocks (not clearAllMocks) -- several tests below set
  // mockEnforcePacing's implementation to throw; clearAllMocks only
  // clears call history, leaving that throwing implementation to leak
  // into the next test. resetAllMocks restores every mock to a bare
  // vi.fn() with no implementation, so enforcePacing is a no-op again by
  // default. scrubSecrets is the one exception -- restore its real
  // passthrough implementation immediately after, since resetAllMocks
  // strips that too and several tests need the real scrubbing behavior.
  vi.resetAllMocks();
  mockScrubSecrets.mockImplementation(realScrubSecrets);
};

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';
