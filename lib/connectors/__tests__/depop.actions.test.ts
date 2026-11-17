import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CONNECTION_ID,
  EXTERNAL_LISTING_ID,
  ITEM_ID,
  beforeEachCreateListingActionRealWithSession,
  beforeEachDepopPlaywrightAction,
  beforeEachUpdateListingActionRealWithSession,
  buildBookListingInput,
  buildListingInput,
  fakePage,
  makeFakePage,
  mockValidateSessionReadOnly,
  mockWithSession,
} from './depop.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import type { ListingInput } from '@/lib/connectors/types';
import type { BookDetails } from '@/lib/types';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  depopConnector,
} from '@/lib/connectors/depop';

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

    it('falls back to an empty string (never crashes) when brand/size_label are missing at runtime despite the type contract requiring them', async () => {
      const input = buildListingInput();
      input.details = { ...input.details, brand: null, size_label: null } as unknown as ListingInput['details'];

      await createListing(input);

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', '');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', '');
    });

    it('checks the fallback "other" category field (and fills the book description) for a book listing, never brand/size/color', async () => {
      await createListing(buildBookListingInput());

      expect(fakePage.check).toHaveBeenCalledWith('[data-testid="listing-category-other"]');
      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nPublisher: Acme Press\nISBN: 9780000000000\nCondition: Good',
      );
      expect(fakePage.fill).not.toHaveBeenCalledWith('[data-testid="listing-brand-input"]', expect.anything());
      expect(fakePage.fill).not.toHaveBeenCalledWith('[data-testid="listing-size-input"]', expect.anything());
    });

    it('omits null book-detail lines from the description via filter(Boolean), producing no blank lines', async () => {
      const input = buildBookListingInput();
      input.details = { ...(input.details as BookDetails), isbn: null, publisher: null };

      await createListing(input);

      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nCondition: Good',
      );
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

    it('does not mutate the caller\'s original photos array in place (sorts a defensive .slice() copy)', async () => {
      const input = buildListingInput();
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
      const input = buildListingInput();
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
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

    it('skips setInputFiles entirely when there are no photos', async () => {
      const input = buildListingInput();
      input.photos = [];

      await createListing(input);

      expect(fakePage.setInputFiles).not.toHaveBeenCalled();
    });

    it('clicks submit and waits for the /products/ URL redirect', async () => {
      await createListing(buildListingInput());

      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="list-item-submit-button"]');
      expect(fakePage.waitForURL).toHaveBeenCalledWith(/\/products\//);
    });

    it('extracts the listing id from a post-submit URL with a trailing query string', async () => {
      fakePage.url = () => 'https://www.depop.com/products/abc123?ref=share';

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: 'abc123' });
    });

    it('falls back to input.itemId when the post-submit URL cannot be parsed for a listing id', async () => {
      fakePage.url = () => 'https://www.depop.com/error';

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: ITEM_ID });
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('updateListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachUpdateListingActionRealWithSession);

    it('navigates to the listing edit page keyed by externalListingId', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' });

      expect(fakePage.goto).toHaveBeenCalledWith(`https://www.depop.com/products/${EXTERNAL_LISTING_ID}/edit/`);
    });

    it('returns not_found and never fills/clicks when the product-not-found element is visible', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);

      const result = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'X' });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.isVisible).toHaveBeenCalledWith('[data-testid="product-not-found"]');
      expect(fakePage.fill).not.toHaveBeenCalled();
      expect(fakePage.click).not.toHaveBeenCalled();
    });

    it('fills only title by value when patch has title but not priceCents (price selector never invoked at all)', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'Updated Title' });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Updated Title');
      expect(
        fakePage.fill.mock.calls.some((call) => call[0] === '[data-testid="listing-price-input"]'),
      ).toBe(false);
    });

    it('fills only price by value (formatted dollars) when patch has priceCents but not title (title selector never invoked at all)', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { priceCents: 999 });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '9.99');
      expect(
        fakePage.fill.mock.calls.some((call) => call[0] === '[data-testid="listing-title-input"]'),
      ).toBe(false);
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('updateListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachUpdateListingActionRealWithSession);

    it('clicks save and returns ok:true, never calling fill at all, when patch is empty', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      const result = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});

      expect(fakePage.fill).not.toHaveBeenCalled();
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('treats a thrown isVisible check (e.g. closed page) as item-found, not not_found -- proceeds to fill/click without crashing', async () => {
      fakePage.isVisible = vi.fn().mockRejectedValue(new Error('closed page'));

      const result = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'X' });

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'X');
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

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

      const result = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(fakePage.goto).toHaveBeenCalledWith(`https://www.depop.com/products/${EXTERNAL_LISTING_ID}/`);
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-mark-as-sold-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('returns not_found and never clicks mark-as-sold when the listing is missing', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);

      const result = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.click).not.toHaveBeenCalled();
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('delistAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

    it('navigates to the listing detail page and clicks delist when found', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(false);

      const result = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(fakePage.goto).toHaveBeenCalledWith(`https://www.depop.com/products/${EXTERNAL_LISTING_ID}/`);
      expect(fakePage.click).toHaveBeenCalledWith('[data-testid="listing-delist-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('returns not_found and never clicks delist when the listing is missing', async () => {
      fakePage.isVisible = vi.fn().mockResolvedValue(true);

      const result = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(fakePage.click).not.toHaveBeenCalled();
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('performDepopLogin and session auth check (via captured SessionHooks)', () => {
    it('performLogin navigates, fills the credential by VALUE (never interpolated into a selector), clicks submit, and waits for authenticated chrome', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildListingInput());

      const hooks = mockWithSession.mock.calls[0][3];
      const page = makeFakePage();
      await hooks.performLogin(page, 'super-secret-password');

      expect(page.goto).toHaveBeenCalledWith('https://www.depop.com/login/');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="login-form-password-input"]',
        'super-secret-password',
      );
      expect(page.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(page.waitForSelector).toHaveBeenCalledWith('[data-testid="shop-nav-link"]', { timeout: 15000 });

      for (const call of page.fill.mock.calls) {
        expect(call[0]).not.toContain('super-secret-password');
      }
    });

    it('validateSession returns true when the shop nav chrome is visible, false otherwise', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildListingInput());

      const hooks = mockWithSession.mock.calls[0][3];

      const authedPage = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
      await expect(hooks.validateSession(authedPage)).resolves.toBe(true);
      expect(authedPage.isVisible).toHaveBeenCalledWith('[data-testid="shop-nav-link"]');

      const unauthedPage = makeFakePage({ isVisible: vi.fn().mockResolvedValue(false) });
      await expect(hooks.validateSession(unauthedPage)).resolves.toBe(false);
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('performDepopLogin and session auth check (via captured SessionHooks)', () => {
    it('validateSession treats a thrown isVisible check as not-authenticated, never throwing', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildListingInput());

      const hooks = mockWithSession.mock.calls[0][3];
      const brokenPage = makeFakePage({
        isVisible: vi.fn().mockRejectedValue(new Error('closed page')),
      });

      await expect(hooks.validateSession(brokenPage)).resolves.toBe(false);
    });
  });

  describe('depopConnector export', () => {
    it('wires the exported Connector object to the real implementations (not an empty stub)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

      const result = await depopConnector.checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);

      mockWithSession.mockResolvedValueOnce({ ok: true });
      const delistResult = await depopConnector.delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(delistResult).toEqual({ ok: true });
    });
  });
});
