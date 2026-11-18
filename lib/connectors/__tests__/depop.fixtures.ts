import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ListingInput } from '@/lib/connectors/types';
import { enforcePacing } from '@/lib/connectors/pacing';
import {
  buildBookInput,
  buildClothingInput,
  makeFakePageWith,
} from './playwrightListingBuilders';
import { mockWithSession } from './playwrightConnectorFixtures';

// This suite mocks the shared Playwright session module
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// lib/rateLimit.ts fixed-window bucket (that's pacing.test.ts's job). It
// also mocks lib/connections.ts#recordSuspensionSignal so the
// suspension-classification tests can assert on it directly. Unlike
// poshmark.test.ts, there's no persistence-layer describe block here --
// Depop has no durable cooldown/share-cap tables to seed against a real
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

export const CONNECTION_ID = 'depop-conn-1';

export const ITEM_ID = 'depop-item-1';

export const EXTERNAL_LISTING_ID = 'DEPOP-LISTING-1';

export function buildListingInput(): ListingInput {
  return buildClothingInput(CONNECTION_ID, ITEM_ID, { title: 'Test Jacket', priceCents: 4500, color: 'Blue' });
}

// Fake Playwright `Page`. Originally only used by the suspension-
// classification tests (invoking the captured SessionHooks#validateSession
// hook directly), now also handed to createListing/updateListing/markSold/
// delist's real action callback by mocking withSession to actually invoke
// it -- see the "(real withSession callback invoked)" describe blocks below
// -- so the real Playwright-interaction code inside those callbacks
// (navigation, value-based fills, id extraction) executes under test instead
// of being skipped as it was when withSession was mocked wholesale with no
// callback invocation.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => `https://www.depop.com/products/${EXTERNAL_LISTING_ID}/`, isVisible: true }, overrides);
}

export function buildBookListingInput(): ListingInput {
  return buildBookInput(CONNECTION_ID, ITEM_ID);
}

export const beforeEachDepopPlaywrightAction = () => {
  // resetAllMocks (not clearAllMocks) -- several tests below set
  // mockEnforcePacing's implementation to throw; clearAllMocks only
  // clears call history, leaving that throwing implementation to leak
  // into the next test. resetAllMocks restores every mock to a bare
  // vi.fn() with no implementation, so enforcePacing is a no-op again by
  // default.
  vi.resetAllMocks();
};

export let fakePage: ReturnType<typeof makeFakePage>;

export const beforeEachCreateListingActionRealWithSession = () => {
  fakePage = makeFakePage();
  mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
    action(fakePage),
  );
};

export const beforeEachUpdateListingActionRealWithSession = () => {
  fakePage = makeFakePage();
  mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
    action(fakePage),
  );
};

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession } from './playwrightConnectorFixtures';
