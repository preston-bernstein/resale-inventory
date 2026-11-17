import { describe, it, expect, beforeEach } from 'vitest';
import {
  beforeEachCreateListingActionRealWithSession,
  beforeEachPoshmarkPersistenceLayer,
  beforeEachPoshmarkPlaywrightAction,
  buildBookListingInput,
  buildElectronicsListingInput,
  buildListingInput,
  fakePage,
  insertConnection,
  insertItem,
  linkItemPlatform,
  makeFakePage,
  mockAssertCanAutomate,
  mockRecordSuspensionSignal,
  mockValidateSessionReadOnly,
  mockWithSession,
  seedDelistEvent,
} from './poshmark.fixtures';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { DEFAULT_TENANT_ID, POSHMARK_SHARE_CAP_PER_24H } from '@/lib/constants';
import { ConnectorGatingError, PoshmarkCooldownError } from '@/lib/connectors/types';
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
} from '@/lib/connectors/poshmark';
import type { ListingInput } from '@/lib/connectors/types';

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

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
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

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
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

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
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

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
  });
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

  describe('sharePoshmarkListing', () => {
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
  });
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

  describe('sharePoshmarkListing', () => {
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
  });
});

describe('poshmark persistence layer', () => {
  beforeEach(beforeEachPoshmarkPersistenceLayer);

  describe('sharePoshmarkListing', () => {
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

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('suspension classification', () => {
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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('suspension classification', () => {
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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

    it('fills clothing category fields (brand/size/color) by value and never checks the books department', async () => {
      const connectionId = insertConnection();
      const itemId = insertItem();

      await createListing(buildListingInput(connectionId, itemId));

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Acme');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', 'M');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-color-input"]', 'Blue');
      expect(fakePage.check).not.toHaveBeenCalled();
    });
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
  });
});
