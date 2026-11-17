import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  CONNECTION_ID,
  EXTERNAL_LISTING_ID,
  ITEM_ID,
  beforeAllVintedPlaywrightAction,
  beforeEachVintedPlaywrightAction,
  buildBookListingInput,
  buildListingInput,
  makeFakePage,
  mockScrubSecrets,
  mockValidateSessionReadOnly,
  mockWithSession,
  wireRealSession,
} from './vinted.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyVintedSuspension,
  vintedConnector,
} from '@/lib/connectors/vinted';

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('updateListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the item edit page and returns not_found without filling/clicking anything when the item is missing', async () => {
      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="item-not-found"]'),
      });
      wireRealSession(page);

      const result = await updateListing('404-listing', DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' });

      expect(page.goto).toHaveBeenCalledWith('https://www.vinted.com/items/404-listing/edit');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).not.toHaveBeenCalled();
    });

    it('fills only the patched fields by VALUE and saves when the item exists, filling nothing for an empty patch', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const emptyPatchResult = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).toHaveBeenCalledWith('[data-testid="upload-save-button"]');
      expect(emptyPatchResult).toEqual({ ok: true });

      page.fill.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'Updated Title' });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-title-input"]', 'Updated Title');
      expect(page.fill).not.toHaveBeenCalledWith('[data-testid="upload-price-input"]', expect.anything());

      page.fill.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { priceCents: 999 });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-price-input"]', '9.99');
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('markSoldAction / delistAction (real callback invoked via a wired withSession)', () => {
    it('markSold navigates to the item detail page, skips clicking when not found, clicks mark-as-sold when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="item-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(notFoundPage.goto).toHaveBeenCalledWith(`https://www.vinted.com/items/${EXTERNAL_LISTING_ID}`);
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="item-mark-as-sold-button"]');
      expect(foundResult).toEqual({ ok: true });
    });

    it('delist navigates to the item detail page, skips clicking when not found, clicks delist when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="item-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="item-delist-button"]');
      expect(foundResult).toEqual({ ok: true });
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('suspension regex: \\s+ (one-or-more) vs \\s (exactly-one) boundary cases', () => {
    it('vinted pattern 1 (account has been disabled/banned) matches with double spaces at every gap', () => {
      expect(classifyVintedSuspension('Your account  has  been  banned.')).not.toBeNull();
    });

    it('vinted pattern 2 (your account is/has been ... blocked/restricted/suspended) matches with double spaces at every gap', () => {
      expect(
        classifyVintedSuspension('your  account  has  been  temporarily  blocked for review.'),
      ).not.toBeNull();
    });

    it('vinted pattern 2 matches without "temporarily" -- that group is optional, not mandatory', () => {
      expect(classifyVintedSuspension('Your account is blocked.')).not.toBeNull();
    });

    it('vinted pattern 3 (this account is/has been closed) matches with double spaces at every gap', () => {
      expect(classifyVintedSuspension('this  account  has  been  closed permanently.')).not.toBeNull();
    });

    it('vinted pattern 4 (violated of our/vinted\'s terms/polic) matches with double spaces at every gap', () => {
      expect(classifyVintedSuspension('This is a violation  of  our  terms of service.')).not.toBeNull();
    });

    it('vinted pattern 4 matches "vinteds" (no apostrophe) -- the apostrophe is optional, not mandatory', () => {
      expect(classifyVintedSuspension('This is a violation of vinteds policy.')).not.toBeNull();
    });
  });

  describe('detectAndRecordSuspension scrubs with an empty secrets list', () => {
    it('calls scrubSecrets(reason, []) -- never a non-empty secrets array', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ content: async () => 'Your account has been banned.' });
      await hooks.validateSession(page);

      expect(mockScrubSecrets).toHaveBeenCalledWith(expect.any(String), []);
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('isAuthenticatedVintedSession / isItemNotFound check the EXACT selector string', () => {
    it('validateSession reports authenticated only when isVisible is asked for the real wardrobe-nav selector', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="wardrobe-nav-link"]'),
      });

      const authenticated = await hooks.validateSession(page);
      expect(authenticated).toBe(true);
    });

    it('catches an isVisible rejection and treats the session as unauthenticated rather than throwing', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });

      await expect(hooks.validateSession(page)).resolves.toBe(false);
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('performLogin session hook (invoked directly against a fake page)', () => {
    it('navigates to /member/login, fills the credential VALUE, submits, and waits for the wardrobe-nav selector', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      await createListing(buildListingInput());
      const hooks = mockWithSession.mock.calls[0][3];

      const loginPage = makeFakePage();
      await hooks.performLogin(loginPage, 'super-secret-password');

      expect(loginPage.goto).toHaveBeenCalledWith('https://www.vinted.com/member/login');
      expect(loginPage.fill).toHaveBeenCalledWith(
        '[data-testid="login-form-password-input"]',
        'super-secret-password',
      );
      expect(loginPage.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(loginPage.waitForSelector).toHaveBeenCalledWith('[data-testid="wardrobe-nav-link"]', {
        timeout: 15000,
      });
    });
  });

  describe('buildListingDescription (exercised via createListing)', () => {
    it('joins all present clothing fields with newlines, in brand/size/color/condition order', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput());

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="upload-description-input"]',
        'Brand: Acme\nSize: M\nColor: Blue\nCondition: GUC',
      );
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('buildListingDescription (exercised via createListing)', () => {
    it('omits a clothing field entirely (no blank line) when its value is null', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput();
      (input.details as { color: string | null }).color = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="upload-description-input"]',
        'Brand: Acme\nSize: M\nCondition: GUC',
      );
    });

    it('joins all present book fields with newlines, in author/publisher/isbn/condition order', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildBookListingInput());

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="upload-description-input"]',
        'By Jane Author\nPublisher: Acme Press\nISBN: 9780000000000\nCondition: Good',
      );
    });

    it('omits missing book fields (publisher/isbn null) rather than leaving blank lines', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildBookListingInput();
      (input.details as { publisher: string | null; isbn: string | null }).publisher = null;
      (input.details as { publisher: string | null; isbn: string | null }).isbn = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="upload-description-input"]',
        'By Jane Author\nCondition: Good',
      );
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('fillCategoryFields null/undefined fallbacks', () => {
    it('falls back to an empty string for brand when null, never a placeholder value', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput();
      (input.details as { brand: string | null }).brand = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-brand-input"]', '');
    });

    it('falls back to an empty string for size_label when null, never a placeholder value', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput();
      (input.details as { size_label: string | null }).size_label = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-size-input"]', '');
    });

    it('never fills the color field at all when color is null (guarded by `if (d.color)`)', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput();
      (input.details as { color: string | null }).color = null;

      await createListing(input);

      const colorFillCalls = page.fill.mock.calls.filter(
        ([selector]) => selector === '[data-testid="upload-color-input"]',
      );
      expect(colorFillCalls).toHaveLength(0);
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('extractListingIdFromUrl anchor behavior (exercised via createListing)', () => {
    it('extracts the id when the URL has no trailing slash', async () => {
      const page = makeFakePage({ url: () => 'https://www.vinted.com/items/555666' });
      wireRealSession(page);

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: '555666' });
    });

    it('extracts the id when a "-slug" suffix follows the digits', async () => {
      const page = makeFakePage({ url: () => 'https://www.vinted.com/items/555666-cool-jacket' });
      wireRealSession(page);

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: '555666' });
    });

    it('falls back to input.itemId when trailing non-slug path segments follow the id', async () => {
      const page = makeFakePage({ url: () => 'https://www.vinted.com/items/555666/reviews' });
      wireRealSession(page);

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: ITEM_ID });
    });
  });

  describe('vintedConnector', () => {
    it('exposes all 5 Connector methods', () => {
      expect(vintedConnector.createListing).toBe(createListing);
      expect(vintedConnector.updateListing).toBe(updateListing);
      expect(vintedConnector.markSold).toBe(markSold);
      expect(vintedConnector.delist).toBe(delist);
      expect(vintedConnector.checkConnectionHealth).toBe(checkConnectionHealth);
    });
  });
});
