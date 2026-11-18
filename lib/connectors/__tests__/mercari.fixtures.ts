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
import { mockWithSession } from './playwrightScrubSpyFixtures';

// mercari.ts never touches the DB directly (unlike poshmark.ts, which has a
// durable relist-cooldown/share-cap persistence layer) -- every mutating
// method's ban-risk mitigation is lib/connectors/pacing.ts's in-memory
// enforcePacing() instead. So this suite mocks all three of mercari.ts's
// external collaborators wholesale: the shared Playwright session module
// (withSession/validateSessionReadOnly), lib/connections.ts#
// recordSuspensionSignal, and lib/connectors/pacing.ts#enforcePacing. No
// real browser is ever launched and no real DB row is ever required.
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

export function buildListingInput(connectionId: string, itemId: string): ListingInput {
  return buildClothingInput(connectionId, itemId, { title: 'Test Shirt', priceCents: 2500, color: 'Blue' });
}

// Fake Playwright `Page` -- only used directly by the suspension-
// classification tests below, which invoke the SessionHooks#validateSession
// hook this file builds (captured from a mocked withSession/
// validateSessionReadOnly call) against it, simulating what
// playwrightSession.ts's real (non-mocked) implementation would pass in.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => 'https://www.mercari.com/us/item/m12345678/', isVisible: false }, overrides);
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
 * Wires the mocked withSession to actually invoke the callback passed to it
 * (the real createListingAction/updateListingAction/markSoldAction/
 * delistAction closures) against `page` -- rather than just recording that
 * withSession was called. This is what lets the tests below exercise the
 * real Playwright-interaction code (navigation, fills, id extraction) that
 * every other test in this file deliberately never reaches.
 */
export function wireRealSession(page: ReturnType<typeof makeFakePage>) {
  wireSessionTo(mockWithSession, page);
}

export const beforeEachMercariPlaywrightAction = () => {
  vi.clearAllMocks();
};

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';
