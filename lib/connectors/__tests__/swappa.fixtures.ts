import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { ListingInput } from '@/lib/connectors/types';
import { enforcePacing } from '@/lib/connectors/pacing';
import { assertCanAutomate } from '@/lib/automationGate';
import { recordListingCreated } from '@/lib/connectors/itemPlatformsWrite';
import {
  buildBookInput,
  buildClothingInput,
  buildElectronicsInput,
  makeFakePageWith,
  wireSessionTo,
} from './playwrightListingBuilders';
import { mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';

// This suite mocks the shared Playwright session module
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// in-memory rate-limit bucket (that's pacing.test.ts's job). It also mocks
// lib/connections.ts#recordSuspensionSignal/getDecryptedCredential/
// getConnection/rotateCredential (the latter three only used by the
// "dry-run behavior" describe block below, which drives the REAL
// playwrightSession.ts#withSession directly via vi.importActual to prove
// Swappa's own dry-run log line, without ever touching this file's mocked
// withSession). Like grailed.test.ts/vinted.test.ts (this file's structural
// model, since swappa.ts was built to mirror grailed.ts), there's no
// persistence-layer describe block here -- Swappa has no durable cooldown/
// share-cap tables to seed against a real scratch DB; enforcePacing is its
// entire ban-risk mitigation story, and that's a pure mock in this file.
// Partial mock: keeps the real buildSessionHooks/isElementVisible (pure, no
// I/O -- shared by every Playwright-driven connector, see
// playwrightSession.ts) so this file's wiring/suspension-check assertions
// still exercise real behavior, while withSession/validateSessionReadOnly
// (the only exports that touch playwright/credentials) stay mocked.
vi.mock('@/lib/connectors/pacing', () => ({
  enforcePacing: vi.fn(),
}));

// getDecryptedCredential/getConnection/rotateCredential are only exercised
// directly by the "dry-run behavior" describe block (against the REAL
// withSession); every other describe block in this file only needs
// recordSuspensionSignal mocked.
// Mocked so the "gating" describe block can drive buildConnector('swappa',
// swappaConnector) (lib/connectors/gate.ts) against a controllable
// consent/connection-status result, without hitting the real DB-backed
// lib/automationGate.ts/lib/consent.ts, and without recordListingCreated
// touching the real item_platforms table.
vi.mock('@/lib/automationGate', () => ({
  assertCanAutomate: vi.fn(),
}));

vi.mock('@/lib/connectors/itemPlatformsWrite', () => ({
  recordListingCreated: vi.fn(),
}));

export const mockEnforcePacing = enforcePacing as unknown as Mock;

export const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;

export const mockRecordListingCreated = recordListingCreated as unknown as Mock;

export let realScrubSecrets: (typeof import('@/lib/connectors/scrub'))['scrubSecrets'];

export let realWithSession: (typeof import('@/lib/connectors/playwrightSession'))['withSession'];

export const CONNECTION_ID = 'swappa-conn-1';

export const ITEM_ID = 'swappa-item-1';

export const EXTERNAL_LISTING_ID = 'SWAPPA-LISTING-1';

/** Electronics ListingInput -- Swappa is electronics-only. */
export function buildElectronicsListingInput(connectionId: string, itemId: string): ListingInput {
  return buildElectronicsInput(connectionId, itemId);
}

/** Clothing ListingInput -- used only by the category-rejection tests below. */
export function buildClothingListingInput(connectionId: string, itemId: string): ListingInput {
  return buildClothingInput(connectionId, itemId, { title: 'Test Jacket', priceCents: 4500, color: 'Blue' });
}

/** Book ListingInput -- used only by the category-rejection tests below. */
export function buildBookListingInput(connectionId: string, itemId: string): ListingInput {
  return buildBookInput(connectionId, itemId);
}

// Fake Playwright `Page` -- used both by the suspension-classification tests
// (invoking the SessionHooks#validateSession hook this file builds) and by
// the "real callback invoked via a wired withSession" describe blocks below,
// simulating what playwrightSession.ts's real (non-mocked) implementation
// would pass in.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => `https://swappa.com/listings/${EXTERNAL_LISTING_ID}`, isVisible: false }, overrides);
}

/**
 * Wires the mocked withSession to actually invoke the callback passed to it
 * (the real createListingAction/updateListingAction/markSoldAction/
 * delistAction closures) against `page` -- rather than just recording that
 * withSession was called. This is what lets the tests below exercise the
 * real Playwright-interaction code (navigation, fills, id extraction) that
 * the rest of this file deliberately never reaches.
 */
export function wireRealSession(page: ReturnType<typeof makeFakePage>) {
  wireSessionTo(mockWithSession, page);
}

export const beforeAllSwappa = async () => {
  const scrubActual = await vi.importActual<typeof import('@/lib/connectors/scrub')>('@/lib/connectors/scrub');
  realScrubSecrets = scrubActual.scrubSecrets;

  const sessionActual = await vi.importActual<typeof import('@/lib/connectors/playwrightSession')>(
    '@/lib/connectors/playwrightSession',
  );
  realWithSession = sessionActual.withSession;
};

export const beforeEachSwappa = () => {
  // resetAllMocks (not clearAllMocks) -- several tests below set
  // mockEnforcePacing/mockAssertCanAutomate's implementation to throw or
  // return a fixed value; clearAllMocks only clears call history, leaving
  // that implementation to leak into the next test. resetAllMocks
  // restores every mock to a bare vi.fn() with no implementation, so
  // enforcePacing/assertCanAutomate are no-ops/undefined again by
  // default. scrubSecrets is the one exception -- restore its real
  // passthrough implementation immediately after, since resetAllMocks
  // strips that too and several tests need the real scrubbing behavior.
  vi.resetAllMocks();
  mockScrubSecrets.mockImplementation(realScrubSecrets);
};

export const FAKE_CREDENTIAL = 'super-secret-swappa-password';

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession, mockScrubSecrets } from './playwrightScrubSpyFixtures';
