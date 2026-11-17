import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beforeEachCreateListingActionRealWithSession,
  beforeEachDelistActionRealWithSession,
  beforeEachPoshmarkPlaywrightAction,
  beforeEachUpdateListingActionRealWithSession,
  buildBookListingInput,
  buildListingInput,
  fakePage,
  insertConnection,
  insertItem,
  linkItemPlatform,
  makeFakePage,
  mockValidateSessionReadOnly,
  mockWithSession,
} from './poshmark.fixtures';
import db from '@/lib/db';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import type { BookDetails } from '@/lib/types';
import {
  checkRelistCooldown,
  createListing,
  updateListing,
  markSold,
  delist,
  poshmarkConnector,
} from '@/lib/connectors/poshmark';
import type { ListingInput } from '@/lib/connectors/types';

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

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
    beforeEach(beforeEachUpdateListingActionRealWithSession);

    it('navigates to the listing edit page keyed by externalListingId', async () => {
      const connectionId = insertConnection();
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      await updateListing('POSH-EDIT-1', DEFAULT_TENANT_ID, connectionId, { title: 'New title' });

      expect(fakePage.goto).toHaveBeenCalledWith('https://poshmark.com/listing/POSH-EDIT-1/edit');
    });
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('updateListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachUpdateListingActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('updateListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachUpdateListingActionRealWithSession);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('delistAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachDelistActionRealWithSession);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('delistAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachDelistActionRealWithSession);

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
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

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
  });
});

describe('poshmark playwright action layer', () => {
  beforeEach(beforeEachPoshmarkPlaywrightAction);

  describe('performPoshmarkLogin and session auth check (via captured SessionHooks)', () => {
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
