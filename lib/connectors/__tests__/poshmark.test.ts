import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { DEFAULT_TENANT_ID, POSHMARK_SHARE_CAP_PER_24H } from '@/lib/constants';
import { ConnectorGatingError, PoshmarkCooldownError } from '@/lib/connectors/types';
import type { BookDetails } from '@/lib/types';

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
}));

import { assertCanAutomate } from '@/lib/automationGate';
import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { recordSuspensionSignal } from '@/lib/connections';
import {
  checkRelistCooldown,
  recordDelistEvent,
  checkShareCap,
  recordShareEvent,
  sharePoshmarkListing,
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyPoshmarkSuspension,
  poshmarkConnector,
} from '@/lib/connectors/poshmark';
import type { ListingInput } from '@/lib/connectors/types';

const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;
const mockWithSession = withSession as unknown as Mock;
const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;
const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;

// This suite only covers the persistence/gating layer built in this task.
// A follow-up task adds the Playwright action layer (createListing/
// updateListing/markSold/delist/checkConnectionHealth) to lib/connectors/
// poshmark.ts and should add its own top-level `describe` block below,
// alongside this one, rather than folding into it.
describe('poshmark persistence layer', () => {
  beforeEach(() => {
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
  });

  function insertConnection(): string {
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

  function insertItem(): string {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO items (id, tenant_id, category, title, acquisition_cost, acquisition_date, status)
       VALUES (?, ?, 'clothing', 'Test Shirt', 1000, '2024-01-01', 'Unlisted')`,
    ).run(id, DEFAULT_TENANT_ID);
    return id;
  }

  function seedDelistEvent(connectionId: string, itemId: string, daysAgo: number): void {
    db.prepare(
      `INSERT INTO poshmark_delist_events (id, tenant_id, connection_id, item_id, delisted_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    ).run(uuidv4(), DEFAULT_TENANT_ID, connectionId, itemId, `-${daysAgo} days`);
  }

  describe('checkRelistCooldown', () => {
    it('returns false (allowed) when the item has never been delisted through this connection', () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      expect(checkRelistCooldown(connectionId, itemId)).toBe(false);
    });

    it('returns true (blocked) for an item delisted 30 days ago -- inside the 60-day cooldown', () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      seedDelistEvent(connectionId, itemId, 30);

      expect(checkRelistCooldown(connectionId, itemId)).toBe(true);
    });

    it('returns false (allowed) for an item delisted 61 days ago -- outside the 60-day cooldown', () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      seedDelistEvent(connectionId, itemId, 61);

      expect(checkRelistCooldown(connectionId, itemId)).toBe(false);
    });

    it('keys off the most recent delist, not the oldest', () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      seedDelistEvent(connectionId, itemId, 90);
      seedDelistEvent(connectionId, itemId, 10);

      expect(checkRelistCooldown(connectionId, itemId)).toBe(true);
    });
  });

  describe('recordDelistEvent', () => {
    it('inserts a row that checkRelistCooldown then reports as blocking', () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      expect(checkRelistCooldown(connectionId, itemId)).toBe(false);

      recordDelistEvent(DEFAULT_TENANT_ID, connectionId, itemId);

      const rows = db
        .prepare('SELECT * FROM poshmark_delist_events WHERE connection_id = ? AND item_id = ?')
        .all(connectionId, itemId);
      expect(rows).toHaveLength(1);
      expect(checkRelistCooldown(connectionId, itemId)).toBe(true);
    });
  });

  describe('checkShareCap', () => {
    it('returns false (allowed) for a connection under the cap', () => {
      const connectionId = insertConnection();

      expect(checkShareCap(connectionId)).toBe(false);
    });

    it('returns true (blocked) once POSHMARK_SHARE_CAP_PER_24H share events exist within the last 24h', () => {
      const connectionId = insertConnection();

      // Seeded via a direct SQL insert loop inside one transaction -- far
      // faster than POSHMARK_SHARE_CAP_PER_24H (3500) sequential
      // recordShareEvent() calls, and just as valid a fixture since
      // recordShareEvent is itself a thin one-row INSERT wrapper (proven
      // separately below).
      const insert = db.prepare(
        `INSERT INTO poshmark_share_events (id, tenant_id, connection_id, shared_at)
         VALUES (?, ?, ?, datetime('now'))`,
      );
      db.transaction(() => {
        for (let i = 0; i < POSHMARK_SHARE_CAP_PER_24H; i++) {
          insert.run(uuidv4(), DEFAULT_TENANT_ID, connectionId);
        }
      })();

      expect(checkShareCap(connectionId)).toBe(true);
    });

    it('does not count share events older than 24h against the cap', () => {
      const connectionId = insertConnection();
      db.prepare(
        `INSERT INTO poshmark_share_events (id, tenant_id, connection_id, shared_at)
         VALUES (?, ?, ?, datetime('now', '-25 hours'))`,
      ).run(uuidv4(), DEFAULT_TENANT_ID, connectionId);

      expect(checkShareCap(connectionId)).toBe(false);
    });
  });

  describe('recordShareEvent', () => {
    it('inserts a row scoped to the given tenant and connection', () => {
      const connectionId = insertConnection();

      recordShareEvent(DEFAULT_TENANT_ID, connectionId);

      const rows = db
        .prepare('SELECT * FROM poshmark_share_events WHERE connection_id = ?')
        .all(connectionId) as Array<{ tenant_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
    });
  });

  describe('sharePoshmarkListing', () => {
    it('throws ConnectorGatingError(missing_consent) and never records a share event when consent is missing', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'consent_required' });

      let caught: unknown;
      try {
        await sharePoshmarkListing(DEFAULT_TENANT_ID, connectionId, itemId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConnectorGatingError);
      expect((caught as ConnectorGatingError).kind).toBe('missing_consent');
      const rows = db
        .prepare('SELECT * FROM poshmark_share_events WHERE connection_id = ?')
        .all(connectionId);
      expect(rows).toHaveLength(0);
    });

    it('throws ConnectorGatingError(connection_not_active) when the connection is not active', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'not_active' });

      let caught: unknown;
      try {
        await sharePoshmarkListing(DEFAULT_TENANT_ID, connectionId, itemId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConnectorGatingError);
      expect((caught as ConnectorGatingError).kind).toBe('connection_not_active');
    });

    it('throws PoshmarkCooldownError(share_cap) and does not record another share event when already at the cap', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      mockAssertCanAutomate.mockReturnValue({ ok: true });

      const insert = db.prepare(
        `INSERT INTO poshmark_share_events (id, tenant_id, connection_id, shared_at)
         VALUES (?, ?, ?, datetime('now'))`,
      );
      db.transaction(() => {
        for (let i = 0; i < POSHMARK_SHARE_CAP_PER_24H; i++) {
          insert.run(uuidv4(), DEFAULT_TENANT_ID, connectionId);
        }
      })();

      let caught: unknown;
      try {
        await sharePoshmarkListing(DEFAULT_TENANT_ID, connectionId, itemId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PoshmarkCooldownError);
      expect((caught as PoshmarkCooldownError).kind).toBe('share_cap');

      const rows = db
        .prepare('SELECT COUNT(*) AS count FROM poshmark_share_events WHERE connection_id = ?')
        .get(connectionId) as { count: number };
      expect(rows.count).toBe(POSHMARK_SHARE_CAP_PER_24H);
    });

    it('succeeds and records a share event under normal (gated-ok, under-cap) conditions', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      mockAssertCanAutomate.mockReturnValue({ ok: true });

      await expect(
        sharePoshmarkListing(DEFAULT_TENANT_ID, connectionId, itemId),
      ).resolves.toBeUndefined();

      const rows = db
        .prepare('SELECT * FROM poshmark_share_events WHERE connection_id = ?')
        .all(connectionId) as Array<{ tenant_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
    });
  });
});

// Sibling suite for the Playwright action layer added in this task
// (createListing/updateListing/markSold/delist/checkConnectionHealth).
// withSession/validateSessionReadOnly are mocked wholesale (top of file) --
// this suite never launches a real browser -- but checkRelistCooldown/
// recordDelistEvent and item_platforms lookups still run against the real
// scratch DB, same rationale as the persistence-layer suite above.
describe('poshmark playwright action layer', () => {
  beforeEach(() => {
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
  });

  function insertConnection(): string {
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

  function insertItem(): string {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO items (id, tenant_id, category, title, acquisition_cost, acquisition_date, status)
       VALUES (?, ?, 'clothing', 'Test Shirt', 1000, '2024-01-01', 'Unlisted')`,
    ).run(id, DEFAULT_TENANT_ID);
    return id;
  }

  function seedDelistEvent(connectionId: string, itemId: string, daysAgo: number): void {
    db.prepare(
      `INSERT INTO poshmark_delist_events (id, tenant_id, connection_id, item_id, delisted_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    ).run(uuidv4(), DEFAULT_TENANT_ID, connectionId, itemId, `-${daysAgo} days`);
  }

  function linkItemPlatform(itemId: string, externalListingId: string): void {
    db.prepare(
      `INSERT INTO item_platforms (id, item_id, tenant_id, platform, external_listing_id, listed_at)
       VALUES (?, ?, ?, 'poshmark', ?, datetime('now'))`,
    ).run(uuidv4(), itemId, DEFAULT_TENANT_ID, externalListingId);
  }

  function buildListingInput(connectionId: string, itemId: string): ListingInput {
    return {
      itemId,
      tenantId: DEFAULT_TENANT_ID,
      connectionId,
      title: 'Test Shirt',
      priceCents: 2500,
      category: 'clothing',
      details: {
        brand: 'Acme',
        size_label: 'M',
        color: 'Blue',
        material: null,
        gender_department: null,
        weight_oz: null,
        pit_to_pit_in: null,
        length_in: null,
        sleeve_length_in: null,
        waist_in: null,
        rise_in: null,
        inseam_in: null,
        leg_opening_in: null,
        hip_in: null,
        condition: 'GUC',
      },
      photos: [],
    };
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
  function makeFakePage(
    overrides: {
      content?: () => Promise<string>;
      url?: () => string;
      isVisible?: (selector: string) => Promise<boolean>;
    } = {},
  ) {
    return {
      goto: vi.fn(),
      fill: vi.fn(),
      check: vi.fn(),
      click: vi.fn(),
      waitForURL: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      url: overrides.url ?? (() => 'https://poshmark.com/listing/test-shirt-abc123'),
      content: overrides.content ?? (async () => ''),
      setInputFiles: vi.fn(),
      isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(true),
    };
  }

  function buildBookListingInput(connectionId: string, itemId: string): ListingInput {
    return {
      itemId,
      tenantId: DEFAULT_TENANT_ID,
      connectionId,
      title: 'Test Book',
      priceCents: 1500,
      category: 'book',
      details: {
        isbn: '9780000000000',
        author: 'Jane Author',
        publisher: 'Acme Press',
        condition: 'Good',
      },
      photos: [],
    };
  }

  function buildElectronicsListingInput(connectionId: string, itemId: string): ListingInput {
    return {
      itemId,
      tenantId: DEFAULT_TENANT_ID,
      connectionId,
      title: 'Test MacBook Pro',
      priceCents: 150000,
      category: 'electronics',
      details: {
        device_type: 'laptop',
        brand: 'Apple',
        model: 'MacBook Pro',
        processor: 'M2',
        ram_gb: 16,
        storage_gb: 512,
        screen_size_in: 14,
        battery_health_pct: 92,
        battery_cycle_count: 50,
        condition: 'Excellent',
      },
      photos: [],
    };
  }

  describe('createListing relist cooldown gating', () => {
    it('throws PoshmarkCooldownError(relist_cooldown) and never calls withSession for an item delisted 30 days ago', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      seedDelistEvent(connectionId, itemId, 30);

      let caught: unknown;
      try {
        await createListing(buildListingInput(connectionId, itemId));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PoshmarkCooldownError);
      expect((caught as PoshmarkCooldownError).kind).toBe('relist_cooldown');
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('succeeds (calls withSession) for an item delisted 61 days ago -- outside the cooldown', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      seedDelistEvent(connectionId, itemId, 61);
      mockWithSession.mockResolvedValue({ externalListingId: 'POSH-NEW-1' });

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(result).toEqual({ externalListingId: 'POSH-NEW-1' });
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('delist', () => {
    it('succeeds and calls recordDelistEvent, inserting a poshmark_delist_events row', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const externalListingId = 'POSH-DELIST-1';
      linkItemPlatform(itemId, externalListingId);
      mockWithSession.mockResolvedValue({ ok: true });

      const result = await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ ok: true });
      const rows = db
        .prepare('SELECT * FROM poshmark_delist_events WHERE connection_id = ? AND item_id = ?')
        .all(connectionId, itemId);
      expect(rows).toHaveLength(1);
      // Proves the cooldown is actually populated, not just that a row
      // exists with the wrong shape.
      expect(checkRelistCooldown(connectionId, itemId)).toBe(true);
    });

    it('does not call recordDelistEvent when the delist action reports not_found', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const externalListingId = 'POSH-DELIST-2';
      linkItemPlatform(itemId, externalListingId);
      mockWithSession.mockResolvedValue({ ok: false, reason: 'not_found' });

      const result = await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      const rows = db
        .prepare('SELECT * FROM poshmark_delist_events WHERE connection_id = ? AND item_id = ?')
        .all(connectionId, itemId);
      expect(rows).toHaveLength(0);
    });
  });

  describe('delegation to the shared Playwright session harness', () => {
    it('createListing/updateListing/markSold/delist each call the mocked withSession exactly once, never driving Playwright directly', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const externalListingId = 'POSH-DELEGATE-1';
      linkItemPlatform(itemId, externalListingId);

      mockWithSession.mockResolvedValueOnce({ externalListingId });
      await createListing(buildListingInput(connectionId, itemId));
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await updateListing(externalListingId, DEFAULT_TENANT_ID, connectionId, { title: 'New title' });
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await markSold(externalListingId, DEFAULT_TENANT_ID, connectionId);
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkConnectionHealth', () => {
    it('calls validateSessionReadOnly and never withSession', async () => {
      const connectionId = insertConnection();
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

      const result = await checkConnectionHealth(DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);
      expect(mockValidateSessionReadOnly).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        connectionId,
        expect.any(Object),
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });

  describe('suspension classification', () => {
    it('classifyPoshmarkSuspension matches known Poshmark suspension/restriction banner text', () => {
      expect(classifyPoshmarkSuspension('Your account has been deactivated.')).not.toBeNull();
      expect(classifyPoshmarkSuspension('Sorry, your account is temporarily restricted.')).not.toBeNull();
    });

    it('classifyPoshmarkSuspension returns null for ambiguous/generic content', () => {
      expect(classifyPoshmarkSuspension('')).toBeNull();
      expect(classifyPoshmarkSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifyPoshmarkSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });

    it('classifyPoshmarkSuspension matches "violation"/"violated" without a trailing s (the s is optional, not required)', () => {
      expect(classifyPoshmarkSuspension('Account restricted: violation of our policy.')).not.toBeNull();
      expect(classifyPoshmarkSuspension('Account restricted: violated of our policy.')).not.toBeNull();
    });

    it('classifyPoshmarkSuspension matches "poshmarks policy" without an apostrophe (the apostrophe is optional, not required)', () => {
      expect(classifyPoshmarkSuspension('Account restricted: violation of poshmarks policy.')).not.toBeNull();
    });

    it('classifyPoshmarkSuspension matches across runs of multiple whitespace characters between words, never requiring exactly one space', () => {
      expect(classifyPoshmarkSuspension('Your  account  has  been  deactivated.')).not.toBeNull();
      expect(classifyPoshmarkSuspension('Your  account  is  temporarily  restricted.')).not.toBeNull();
      expect(classifyPoshmarkSuspension('Your  account  has  been  restricted.')).not.toBeNull();
      expect(classifyPoshmarkSuspension('Your  account  has  been  suspended.')).not.toBeNull();
      expect(
        classifyPoshmarkSuspension('Account restricted due to violation  of  our  policy.'),
      ).not.toBeNull();
    });

    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      const connectionId = insertConnection();
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, connectionId);

      // Capture the SessionHooks this file built and passed to the mocked
      // validateSessionReadOnly, then drive its validateSession hook
      // directly against a fake page -- simulating what
      // playwrightSession.ts's real implementation would do.
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];
      const page = makeFakePage({
        content: async () => 'Your account has been deactivated for policy violations.',
      });

      await hooks.validateSession(page);

      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [tenantId, connId, reason, toStatus] = mockRecordSuspensionSignal.mock.calls[0];
      expect(tenantId).toBe(DEFAULT_TENANT_ID);
      expect(connId).toBe(connectionId);
      expect(typeof reason).toBe('string');
      expect(toStatus).toBe('suspended');
    });

    it('does not record a suspension signal for an ambiguous/transient page-content failure (e.g. navigation timeout)', async () => {
      const connectionId = insertConnection();
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, connectionId);

      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      // Case 1: page.content() itself throws (e.g. a navigation timeout).
      const timeoutPage = makeFakePage({
        content: async () => {
          throw new Error('Timeout 30000ms exceeded.');
        },
      });
      await hooks.validateSession(timeoutPage);

      // Case 2: page.content() resolves, but to unrelated/ambiguous text.
      const genericPage = makeFakePage({ content: async () => '<html>Something went wrong</html>' });
      await hooks.validateSession(genericPage);

      expect(mockRecordSuspensionSignal).not.toHaveBeenCalled();
    });
  });

  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

    it('navigates to the create-listing page and fills title/description/price by VALUE, never by selector interpolation', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(fakePage.goto).toHaveBeenCalledWith('https://poshmark.com/create-listing');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Test Shirt');
      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nColor: Blue\nCondition: GUC',
      );
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '25.00');

      // Selector strings themselves must be the static literal -- the
      // tenant's title/description text must never be interpolated into a
      // selector string (spec requirement).
      for (const call of fakePage.fill.mock.calls) {
        expect(call[0]).not.toContain('Test Shirt');
        expect(call[0].startsWith('[data-testid="')).toBe(true);
      }
      expect(result).toEqual({ externalListingId: 'abc123' });
    });

    it('fills clothing category fields (brand/size/color) by value and never checks the books department', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Acme');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', 'M');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-color-input"]', 'Blue');
      expect(fakePage.check).not.toHaveBeenCalled();
    });

    it('skips the color fill entirely (never calls it, even with a falsy value) when color is null, and omits it from the description with no blank line', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildListingInput(connectionId, itemId);
      input.details = {
        brand: 'Acme',
        size_label: 'M',
        color: null,
        material: null,
        gender_department: null,
        weight_oz: null,
        pit_to_pit_in: null,
        length_in: null,
        sleeve_length_in: null,
        waist_in: null,
        rise_in: null,
        inseam_in: null,
        leg_opening_in: null,
        hip_in: null,
        condition: 'GUC',
      };

      await createListing(input);

      // Asserting a call was never made with a specific VALUE is not enough
      // here (jest/vitest's expect.anything() rejects null/undefined, so it
      // would falsely pass even if fill(selector, null) were actually
      // called) -- assert the selector itself was never invoked at all.
      expect(fakePage.fill.mock.calls.some((call) => call[0] === '[data-testid="listing-color-input"]')).toBe(
        false,
      );
      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nCondition: GUC',
      );
    });

    it('checks the books department field (and fills the book description) for a book listing, never brand/size/color', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildBookListingInput(connectionId, itemId));

      expect(fakePage.check).toHaveBeenCalledWith('[data-testid="listing-department-books"]');
      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nPublisher: Acme Press\nISBN: 9780000000000\nCondition: Good',
      );
      expect(fakePage.fill).not.toHaveBeenCalledWith('[data-testid="listing-brand-input"]', expect.anything());
      expect(fakePage.fill).not.toHaveBeenCalledWith('[data-testid="listing-size-input"]', expect.anything());
    });

    it('creates an electronics listing with brand/model/processor/condition in description, excluding book/clothing fields', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildElectronicsListingInput(connectionId, itemId));

      const descCalls = fakePage.fill.mock.calls.filter((call) => call[0] === '[data-testid="listing-description-input"]');
      expect(descCalls.length).toBeGreaterThan(0);
      const description = descCalls[0][1];
      expect(description).toContain('Apple');
      expect(description).toContain('MacBook Pro');
      expect(description).toContain('M2');
      expect(description).toContain('Excellent');
      // Ensure no book/clothing specific fields
      expect(description).not.toContain('ISBN:');
      expect(description).not.toContain('Size:');
    });

    it('fills every electronics-specific field with the matching selector and value', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildElectronicsListingInput(connectionId, itemId));

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Apple');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-model-input"]', 'MacBook Pro');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-processor-input"]', 'M2');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-ram-input"]', '16');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-storage-input"]', '512');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-screen-size-input"]', '14');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-battery-health-input"]', '92');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-battery-cycle-count-input"]', '50');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-condition-input"]', 'Excellent');
    });

    it('omits optional electronics field fills (processor/ram/storage/screen size/battery) when absent', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildElectronicsListingInput(connectionId, itemId);
      input.details = {
        ...input.details,
        processor: undefined,
        ram_gb: undefined,
        storage_gb: undefined,
        screen_size_in: undefined,
        battery_health_pct: undefined,
        battery_cycle_count: undefined,
      } as unknown as ListingInput['details'];

      await createListing(input);

      const filledSelectors = fakePage.fill.mock.calls.map((call) => call[0]);
      expect(filledSelectors).not.toContain('[data-testid="listing-processor-input"]');
      expect(filledSelectors).not.toContain('[data-testid="listing-ram-input"]');
      expect(filledSelectors).not.toContain('[data-testid="listing-storage-input"]');
      expect(filledSelectors).not.toContain('[data-testid="listing-screen-size-input"]');
      expect(filledSelectors).not.toContain('[data-testid="listing-battery-health-input"]');
      expect(filledSelectors).not.toContain('[data-testid="listing-battery-cycle-count-input"]');
      // brand/model/condition are still required and must always fill
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Apple');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-condition-input"]', 'Excellent');
    });

    it('falls back to an empty string (never crashes) when brand/size_label are missing at runtime despite the type contract requiring them', async () => {
      // ClothingDetails types brand/size_label as required strings, but
      // fillCategoryFields defends against a caller violating that contract
      // at runtime (e.g. untyped JS, a stale row) with `?? ''`. Force that
      // path with an unsafe cast -- this is the one runtime state the type
      // system itself otherwise makes unreachable from well-typed callers.
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildListingInput(connectionId, itemId);
      input.details = { ...input.details, brand: null, size_label: null } as unknown as ListingInput['details'];

      await createListing(input);

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', '');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', '');
    });

    it('omits null book-detail lines from the description via filter(Boolean), producing no blank lines', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildBookListingInput(connectionId, itemId);
      input.details = { ...(input.details as BookDetails), isbn: null, publisher: null };

      await createListing(input);

      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nCondition: Good',
      );
    });

    it('does not mutate the caller\'s original photos array in place (sorts a defensive .slice() copy)', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildListingInput(connectionId, itemId);
      const originalOrder = [
        { id: 'p2', path: '/tmp/2.jpg', sort_order: 2 },
        { id: 'p1', path: '/tmp/1.jpg', sort_order: 1 },
      ];
      input.photos = originalOrder;

      await createListing(input);

      expect(originalOrder.map((p) => p.id)).toEqual(['p2', 'p1']);
      expect(fakePage.setInputFiles).toHaveBeenCalledWith('[data-testid="listing-photo-upload-input"]', [
        '/tmp/1.jpg',
        '/tmp/2.jpg',
      ]);
    });

    it('uploads photos sorted by sort_order via setInputFiles (value-based, never a dynamic selector)', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildListingInput(connectionId, itemId);
      input.photos = [
        { id: 'p2', path: '/tmp/2.jpg', sort_order: 2 },
        { id: 'p1', path: '/tmp/1.jpg', sort_order: 1 },
      ];

      await createListing(input);

      expect(fakePage.setInputFiles).toHaveBeenCalledWith('[data-testid="listing-photo-upload-input"]', [
        '/tmp/1.jpg',
        '/tmp/2.jpg',
      ]);
    });

    it('skips setInputFiles entirely when there are no photos', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();
      const input = buildListingInput(connectionId, itemId);
      input.photos = [];

      await createListing(input);

      expect(fakePage.setInputFiles).not.toHaveBeenCalled();
    });

    it('clicks submit and waits for the /listing/ URL redirect', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="list-item-submit-button"]');
      expect(fakePage.waitForURL).toHaveBeenCalledWith(/\/listing\//);
    });

    it('extracts the listing id from a post-submit URL with a trailing slash', async () => {
      fakePage.url = () => 'https://poshmark.com/listing/blue-jacket-XyZ789/';
      const connectionId = insertConnection();
      const itemId = insertItem();

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(result).toEqual({ externalListingId: 'XyZ789' });
    });

    it('falls back to input.itemId when the post-submit URL cannot be parsed for a listing id', async () => {
      fakePage.url = () => 'https://poshmark.com/create-listing/error';
      const connectionId = insertConnection();
      const itemId = insertItem();

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(result).toEqual({ externalListingId: itemId });
    });

    it('falls back to input.itemId when the listing-slug segment is followed by extra path (id must anchor the end of the URL)', async () => {
      // Distinguishes the trailing `$` anchor in extractListingIdFromUrl's
      // regex: without it, `[^/]*-([a-zA-Z0-9]+)` would happily match the
      // "abc123" segment inside a URL that continues past it (e.g. an
      // edit-page redirect), silently harvesting the wrong id.
      fakePage.url = () => 'https://poshmark.com/listing/blue-jacket-abc123/edit';
      const connectionId = insertConnection();
      const itemId = insertItem();

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(result).toEqual({ externalListingId: itemId });
    });
  });

  describe('updateListingAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

    it('navigates to the listing edit page keyed by externalListingId', async () => {
      const connectionId = insertConnection();
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      await updateListing('POSH-EDIT-1', DEFAULT_TENANT_ID, connectionId, { title: 'New title' });

      expect(fakePage.goto).toHaveBeenCalledWith('https://poshmark.com/listing/POSH-EDIT-1/edit');
    });

    it('returns not_found and never fills/clicks when the listing-not-found element is visible', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);
      const connectionId = insertConnection();

      const result = await updateListing('POSH-EDIT-2', DEFAULT_TENANT_ID, connectionId, { title: 'X' });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.isVisible).toHaveBeenCalledWith('[data-testid="listing-not-found"]');
      expect(fakePage.fill).not.toHaveBeenCalled();
      expect(fakePage.click).not.toHaveBeenCalled();
    });

    it('fills only title by value when patch has title but not priceCents (price selector never invoked at all)', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();

      await updateListing('POSH-EDIT-3', DEFAULT_TENANT_ID, connectionId, { title: 'Updated Title' });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Updated Title');
      // Asserting a call was never made with a specific VALUE is not enough
      // here (expect.anything() rejects null/undefined, so it would falsely
      // pass even if fill(priceSelector, undefined) were actually called
      // because `patch.priceCents !== undefined` collapsed to a constant
      // true) -- assert the selector itself was never invoked.
      expect(
        fakePage.fill.mock.calls.some((call) => call[0] === '[data-testid="listing-price-input"]'),
      ).toBe(false);
    });

    it('fills only price by value (formatted dollars) when patch has priceCents but not title (title selector never invoked at all)', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();

      await updateListing('POSH-EDIT-4', DEFAULT_TENANT_ID, connectionId, { priceCents: 999 });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '9.99');
      expect(
        fakePage.fill.mock.calls.some((call) => call[0] === '[data-testid="listing-title-input"]'),
      ).toBe(false);
    });

    it('clicks save and returns ok:true, never calling fill at all, when patch is empty', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();

      const result = await updateListing('POSH-EDIT-5', DEFAULT_TENANT_ID, connectionId, {});

      expect(fakePage.fill).not.toHaveBeenCalled();
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('treats a thrown isVisible check (e.g. closed page) as item-found, not not_found -- proceeds to fill/click without crashing', async () => {
      fakePage.isVisible = vi.fn().mockRejectedValue(new Error('closed page'));
      const connectionId = insertConnection();

      const result = await updateListing('POSH-EDIT-6', DEFAULT_TENANT_ID, connectionId, { title: 'X' });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'X');
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('markSoldAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

    it('navigates to the listing detail page and clicks mark-as-sold when found', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();

      const result = await markSold('POSH-SOLD-1', DEFAULT_TENANT_ID, connectionId);

      expect(fakePage.goto).toHaveBeenCalledWith('https://poshmark.com/listing/POSH-SOLD-1');
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-mark-as-sold-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('returns not_found and never clicks mark-as-sold when the listing is missing', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);
      const connectionId = insertConnection();

      const result = await markSold('POSH-SOLD-2', DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.click).not.toHaveBeenCalled();
    });
  });

  describe('delistAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

    it('navigates to the listing detail page, clicks delist, and starts the relist cooldown on success', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();
      const itemId = insertItem();
      const externalListingId = 'POSH-REALDELIST-1';
      linkItemPlatform(itemId, externalListingId);

      const result = await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);

      expect(fakePage.goto).toHaveBeenCalledWith(`https://poshmark.com/listing/${externalListingId}`);
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-delist-button"]');
      expect(result).toEqual({ ok: true });
      expect(checkRelistCooldown(connectionId, itemId)).toBe(true);
    });

    it('returns not_found and never clicks delist (or starts a cooldown) when the listing is missing', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);
      const connectionId = insertConnection();
      const itemId = insertItem();
      const externalListingId = 'POSH-REALDELIST-2';
      linkItemPlatform(itemId, externalListingId);

      const result = await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.click).not.toHaveBeenCalled();
      expect(checkRelistCooldown(connectionId, itemId)).toBe(false);
    });

    it('succeeds without crashing and records no cooldown row when no item_platforms mapping exists for the externalListingId', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);
      const connectionId = insertConnection();
      // Deliberately no linkItemPlatform call -- lookupItemIdForListing must
      // return null (never throw on the missing row) and recordDelistEvent
      // must never be called in that case.
      const externalListingId = 'POSH-REALDELIST-NOLINK';

      const result = await delist(externalListingId, DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ ok: true });
      const rows = db
        .prepare('SELECT COUNT(*) AS count FROM poshmark_delist_events WHERE connection_id = ?')
        .get(connectionId) as { count: number };
      expect(rows.count).toBe(0);
    });
  });

  describe('performPoshmarkLogin and session auth check (via captured SessionHooks)', () => {
    it('performLogin navigates, fills the credential by VALUE (never interpolated into a selector), clicks submit, and waits for authenticated chrome', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: 'x' });
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      const hooks = mockWithSession.mock.calls[0][3];
      const page = makeFakePage();
      await hooks.performLogin(page, 'super-secret-password');

      expect(page.goto).toHaveBeenCalledWith('https://poshmark.com/login');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="login-form-password-input"]',
        'super-secret-password',
      );
      expect(page.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(page.waitForSelector).toHaveBeenCalledWith('[data-testid="closet-nav-link"]', { timeout: 15000 });

      for (const call of page.fill.mock.calls) {
        expect(call[0]).not.toContain('super-secret-password');
      }
    });

    it('validateSession returns true when the closet nav chrome is visible, false otherwise', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: 'x' });
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      const hooks = mockWithSession.mock.calls[0][3];

      const authedPage = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
      await expect(hooks.validateSession(authedPage)).resolves.toBe(true);
      expect(authedPage.isVisible).toHaveBeenCalledWith('[data-testid="closet-nav-link"]');

      const unauthedPage = makeFakePage({ isVisible: vi.fn().mockResolvedValue(false) });
      await expect(hooks.validateSession(unauthedPage)).resolves.toBe(false);
    });

    it('validateSession treats a thrown isVisible check as not-authenticated, never throwing', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: 'x' });
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      const hooks = mockWithSession.mock.calls[0][3];
      const brokenPage = makeFakePage({
        isVisible: vi.fn().mockRejectedValue(new Error('closed page')),
      });

      await expect(hooks.validateSession(brokenPage)).resolves.toBe(false);
    });
  });

  describe('poshmarkConnector export', () => {
    it('wires the exported Connector object to the real implementations (not an empty stub)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });
      const connectionId = insertConnection();

      const result = await poshmarkConnector.checkConnectionHealth(DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);

      mockWithSession.mockResolvedValueOnce({ ok: true });
      const delistResult = await poshmarkConnector.delist('POSH-CONNECTOR-1', DEFAULT_TENANT_ID, connectionId);
      expect(delistResult).toEqual({ ok: true });
    });
  });
});
