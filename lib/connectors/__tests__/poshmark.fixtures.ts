import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { assertCanAutomate } from '@/lib/automationGate';
import type { ListingInput } from '@/lib/connectors/types';
import {
  buildBookInput,
  buildClothingInput,
  buildElectronicsInput,
  makeFakePageWith,
} from './playwrightListingBuilders';
import { mockWithSession } from './playwrightConnectorFixtures';

// lib/automationGate.ts hits the real DB (getConnection/hasValidConsent) --
// mock it the same way lib/connectors/__tests__/gate.test.ts does, so the
// `sharePoshmarkListing` gating tests below can drive
// assertCanAutomate's return value directly without needing a fully valid
// consent chain seeded for every test. checkRelistCooldown/recordDelistEvent/
// checkShareCap/recordShareEvent are exercised against the REAL scratch DB
// (BOOKSELLER_DB_PATH, vitest.config.ts) -- they're thin, durable
// persistence wrappers, and the whole point is proving the real SQL against
// the real schema (data/migrations/010_poshmark_pacing.sql).
vi.mock('@/lib/automationGate', () => ({
  assertCanAutomate: vi.fn(),
}));

// The Playwright action layer (below, second describe block) mocks
// playwrightSession.ts's withSession/validateSessionReadOnly wholesale --
// this suite never launches a real browser or imports `playwright`. It also
// mocks lib/connections.ts#recordSuspensionSignal so the suspension-
// classification tests can assert on it directly; nothing in the
// persistence-layer describe block above touches lib/connections.ts (it
// talks to `db` directly), so this mock doesn't affect those tests.
// Partial mock: keeps the real buildSessionHooks/fillClothingFields/
// uploadSortedPhotos (pure, no I/O -- shared by every Playwright-driven
// connector, see playwrightSession.ts) so this file's wiring/category-
// field/photo-upload assertions still exercise real behavior, while
// withSession/validateSessionReadOnly (the only exports that touch
// playwright/credentials) stay mocked.
export const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;

// This suite only covers the persistence/gating layer built in this task.
// A follow-up task adds the Playwright action layer (createListing/
// updateListing/markSold/delist/checkConnectionHealth) to lib/connectors/
// poshmark.ts and should add its own top-level `describe` block below,
// alongside this one, rather than folding into it.
export const beforeEachPoshmarkPersistenceLayer = () => {
  vi.clearAllMocks();
  // poshmark_delist_events/poshmark_share_events both FK onto
  // platform_connections and items -- clear dependents before parents so
  // this doesn't hit a FK error under foreign_keys=ON (lib/db.ts).
  // item_platforms also FKs onto items with NO ON DELETE CASCADE (unlike
  // poshmark_delist_events/poshmark_share_events, which do cascade off
  // platform_connections) -- it's cleared here too, mirroring
  // itemPlatformsWrite.test.ts's convention, since this suite shares the
  // same physical scratch DB file with every other test file and a
  // leftover item_platforms row from another suite would otherwise block
  // `DELETE FROM items` below.
  db.exec(
    `DELETE FROM poshmark_delist_events;
     DELETE FROM poshmark_share_events;
     DELETE FROM item_platforms;
     DELETE FROM item_photos;
     DELETE FROM price_history;
     DELETE FROM clothing_details;
     DELETE FROM book_details;
     DELETE FROM platform_connections;
     DELETE FROM items;`,
  );
};

export function insertConnection(): string {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO platform_connections (id, tenant_id, platform, status, encrypted_credential)
     VALUES (?, ?, 'poshmark', 'active', ?)`,
  // 41 bytes: satisfies platform_connections.encrypted_credential's CHECK
  // (nonce 24B + tag 16B + >=1B ciphertext, per migration 013) -- this is
  // a placeholder blob, never actually decrypted in these tests.
  ).run(id, DEFAULT_TENANT_ID, Buffer.alloc(41));
  return id;
}

export function insertItem(): string {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO items (id, tenant_id, category, title, acquisition_cost, acquisition_date, status)
     VALUES (?, ?, 'clothing', 'Test Shirt', 1000, '2024-01-01', 'Unlisted')`,
  ).run(id, DEFAULT_TENANT_ID);
  return id;
}

export function seedDelistEvent(connectionId: string, itemId: string, daysAgo: number): void {
  db.prepare(
    `INSERT INTO poshmark_delist_events (id, tenant_id, connection_id, item_id, delisted_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`,
  ).run(uuidv4(), DEFAULT_TENANT_ID, connectionId, itemId, `-${daysAgo} days`);
}

// Sibling suite for the Playwright action layer added in this task
// (createListing/updateListing/markSold/delist/checkConnectionHealth).
// withSession/validateSessionReadOnly are mocked wholesale (top of file) --
// this suite never launches a real browser -- but checkRelistCooldown/
// recordDelistEvent and item_platforms lookups still run against the real
// scratch DB, same rationale as the persistence-layer suite above.
export const beforeEachPoshmarkPlaywrightAction = () => {
  vi.clearAllMocks();
  db.exec(
    `DELETE FROM poshmark_delist_events;
     DELETE FROM poshmark_share_events;
     DELETE FROM item_platforms;
     DELETE FROM item_photos;
     DELETE FROM price_history;
     DELETE FROM clothing_details;
     DELETE FROM book_details;
     DELETE FROM platform_connections;
     DELETE FROM items;`,
  );
};

export function linkItemPlatform(itemId: string, externalListingId: string): void {
  db.prepare(
    `INSERT INTO item_platforms (id, item_id, tenant_id, platform, external_listing_id, listed_at)
     VALUES (?, ?, ?, 'poshmark', ?, datetime('now'))`,
  ).run(uuidv4(), itemId, DEFAULT_TENANT_ID, externalListingId);
}

export function buildListingInput(connectionId: string, itemId: string): ListingInput {
  return buildClothingInput(connectionId, itemId, { title: 'Test Shirt', priceCents: 2500, color: 'Blue' });
}

  // Fake Playwright `Page`. Originally only used by the suspension-
// classification tests (invoking the captured SessionHooks#validateSession
// hook directly), now also handed to createListing/updateListing/markSold/
// delist's real action callback by mocking withSession to actually invoke
// it -- see the "(real withSession callback invoked)" describe blocks
// below -- so the real Playwright-interaction code inside those callbacks
// (navigation, value-based fills, id extraction) executes under test
// instead of being skipped as it was when withSession was mocked wholesale
// with no callback invocation.
export function makeFakePage(overrides: Parameters<typeof makeFakePageWith>[1] = {}) {
  return makeFakePageWith({ url: () => 'https://poshmark.com/listing/test-shirt-abc123', isVisible: true }, overrides);
}

export function buildBookListingInput(connectionId: string, itemId: string): ListingInput {
  return buildBookInput(connectionId, itemId);
}

export function buildElectronicsListingInput(connectionId: string, itemId: string): ListingInput {
  return buildElectronicsInput(connectionId, itemId);
}

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

export const beforeEachDelistActionRealWithSession = () => {
  fakePage = makeFakePage();
  mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
    action(fakePage),
  );
};

export { mockRecordSuspensionSignal, mockValidateSessionReadOnly, mockWithSession } from './playwrightConnectorFixtures';
