import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beforeEachMercariPlaywrightAction,
  buildBookListingInput,
  buildElectronicsListingInput,
  buildListingInput,
  makeFakePage,
  mockScrubSecrets,
  mockValidateSessionReadOnly,
  mockWithSession,
  wireRealSession,
} from './mercari.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyMercariSuspension,
  mercariConnector,
} from '@/lib/connectors/mercari';

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('suspension regex: \\s+ (one-or-more) vs \\s (exactly-one) boundary cases', () => {
    // Each string below deliberately puts TWO spaces at every \s+ gap in the
    // pattern it targets. The real \s+ regex still matches (one-or-more);
    // a mutant that narrows any of those gaps to a single \s fails to match
    // this specific input, so these strings distinguish real vs mutant.
    it('mercari pattern 1 (account has been deactivated) matches with double spaces at every gap', () => {
      expect(classifyMercariSuspension('Your account  has  been  deactivated.')).not.toBeNull();
    });

    it('mercari pattern 2 (your account is/has been ... restricted/suspended/locked) matches with double spaces at every gap', () => {
      expect(
        classifyMercariSuspension('your  account  has  been  temporarily  restricted for review.'),
      ).not.toBeNull();
    });

    it('mercari pattern 3 (account suspension) matches with a double space', () => {
      expect(classifyMercariSuspension('Reason: account  suspension')).not.toBeNull();
    });

    it('mercari pattern 4 (violated of our/mercari\'s terms/polic) matches with double spaces at every gap', () => {
      expect(classifyMercariSuspension('This is a violation  of  our  terms of service.')).not.toBeNull();
    });

    it('mercari pattern 4 matches "mercaris" (no apostrophe) -- the apostrophe is optional, not mandatory', () => {
      expect(classifyMercariSuspension('This is a violation of mercaris policy.')).not.toBeNull();
    });
  });

  describe('detectAndRecordSuspension scrubs with an empty secrets list', () => {
    it('calls scrubSecrets(reason, []) -- never a non-empty secrets array', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-scrub');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ content: async () => 'Your account has been deactivated.' });
      await hooks.validateSession(page);

      expect(mockScrubSecrets).toHaveBeenCalledWith(expect.any(String), []);
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('isAuthenticatedMercariSession / isItemNotFound check the EXACT selector string', () => {
    it('validateSession reports authenticated only when isVisible is asked for the real account-nav selector', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-selector');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      // isVisible only returns true for the real, exact selector -- if the
      // source ever passed a different string (e.g. an empty string), this
      // would report false.
      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="account-nav-link"]'),
      });

      const authenticated = await hooks.validateSession(page);
      expect(authenticated).toBe(true);
    });

    it('catches an isVisible rejection and treats the session as unauthenticated rather than throwing', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-selector-throw');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        isVisible: vi.fn().mockRejectedValue(new Error('closed page')),
      });

      await expect(hooks.validateSession(page)).resolves.toBe(false);
    });

    it('updateListing/markSold/delist only classify not_found when isVisible is asked for the real item-not-found selector', async () => {
      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="item-not-found"]'),
      });
      wireRealSession(page);

      const result = await updateListing('MERC-1', DEFAULT_TENANT_ID, 'conn-1', { title: 'New title' });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('isAuthenticatedMercariSession / isItemNotFound check the EXACT selector string', () => {
    it('catches an isVisible rejection in isItemNotFound and treats the item as found rather than throwing', async () => {
      const page = makeFakePage({
        isVisible: vi.fn().mockRejectedValue(new Error('closed page')),
      });
      wireRealSession(page);

      const result = await markSold('MERC-1', DEFAULT_TENANT_ID, 'conn-1');

      expect(result).toEqual({ ok: true });
    });
  });

  describe('performLogin session hook (invoked directly against a fake page)', () => {
    it('navigates to /login, fills the credential VALUE (never the selector), submits, and waits for the account-nav selector', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      // Trigger a real call so buildMercariSessionHooks builds the hooks
      // object passed to the mocked withSession, then invoke performLogin
      // directly -- withSession itself is mocked, so it never calls this
      // for us.
      await createListing(buildListingInput('conn-1', 'item-1'));
      const hooks = mockWithSession.mock.calls[0][3];

      const loginPage = makeFakePage();
      await hooks.performLogin(loginPage, 'super-secret-password');

      expect(loginPage.goto).toHaveBeenCalledWith('https://www.mercari.com/login');
      expect(loginPage.fill).toHaveBeenCalledWith(
        '[data-testid="login-form-password-input"]',
        'super-secret-password',
      );
      expect(loginPage.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(loginPage.waitForSelector).toHaveBeenCalledWith('[data-testid="account-nav-link"]', {
        timeout: 15000,
      });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('buildListingDescription (exercised via createListing)', () => {
    it('joins all present clothing fields with newlines, in brand/size/color/condition order', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nColor: Blue\nCondition: GUC',
      );
    });

    it('omits a clothing field entirely (no blank line) when its value is null, rather than leaving an empty entry', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');
      (input.details as { color: string | null }).color = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nCondition: GUC',
      );
    });

    it('joins all present book fields with newlines, in author/publisher/isbn/condition order', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildBookListingInput('conn-1', 'item-book-1'));

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nPublisher: Acme Press\nISBN: 9780000000000\nCondition: Good',
      );
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('buildListingDescription (exercised via createListing)', () => {
    it('builds an electronics description including brand/model/processor/condition and excludes book/clothing fields', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildElectronicsListingInput('conn-1', 'item-elec-1'));

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('Apple'),
      );
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('MacBook Pro'),
      );
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('M2'),
      );
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('Excellent'),
      );
      // Assert no book/clothing fields
      const descCalls = page.fill.mock.calls.filter((call) => call[0] === '[data-testid="listing-description-input"]');
      const description = descCalls.length > 0 ? descCalls[0][1] : '';
      expect(description).not.toContain('ISBN:');
      expect(description).not.toContain('Size:');
    });

    it('fills the electronics brand and model inputs with the matching selector and value', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildElectronicsListingInput('conn-1', 'item-elec-2'));

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Apple');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-model-input"]', 'MacBook Pro');
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('buildListingDescription (exercised via createListing)', () => {
    it('omits missing book fields (publisher/isbn null) rather than leaving blank lines', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildBookListingInput('conn-1', 'item-book-2');
      (input.details as { publisher: string | null; isbn: string | null }).publisher = null;
      (input.details as { publisher: string | null; isbn: string | null }).isbn = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'By Jane Author\nCondition: Good',
      );
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('fillCategoryFields null/undefined fallbacks', () => {
    it('falls back to an empty string for brand when null, never a placeholder value', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');
      (input.details as { brand: string | null }).brand = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', '');
    });

    it('falls back to an empty string for size_label when null, never a placeholder value', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');
      (input.details as { size_label: string | null }).size_label = null;

      await createListing(input);

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', '');
    });

    it('never fills the color field at all when color is null (guarded by `if (d.color)`, not filled with an empty string)', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');
      (input.details as { color: string | null }).color = null;

      await createListing(input);

      // expect.anything() deliberately would NOT catch a mutant that still
      // calls fill(selector, null) -- it excludes null/undefined -- so
      // assert directly on the selectors actually used instead.
      const colorFillCalls = page.fill.mock.calls.filter(
        ([selector]) => selector === '[data-testid="listing-color-input"]',
      );
      expect(colorFillCalls).toHaveLength(0);
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('extractListingIdFromUrl anchor behavior (exercised via createListing)', () => {
    it('extracts the id when the URL has no trailing slash -- the trailing slash is optional', async () => {
      const page = makeFakePage({ url: () => 'https://www.mercari.com/us/item/m55566677' });
      wireRealSession(page);

      const result = await createListing(buildListingInput('conn-1', 'item-1'));

      expect(result).toEqual({ externalListingId: 'm55566677' });
    });

    it('falls back to input.itemId when trailing path segments follow the id -- the match must reach the end of the string', async () => {
      const page = makeFakePage({
        url: () => 'https://www.mercari.com/us/item/m55566677/reviews',
      });
      wireRealSession(page);

      const input = buildListingInput('conn-1', 'item-anchor-fallback');
      const result = await createListing(input);

      expect(result).toEqual({ externalListingId: 'item-anchor-fallback' });
    });
  });

  describe('updateListingAction fills nothing when the patch is empty', () => {
    it('calls neither fill selector when patch has no title or priceCents, but still saves', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const result = await updateListing('MERC-1', DEFAULT_TENANT_ID, 'conn-1', {});

      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('mercariConnector', () => {
    it('exposes all 5 Connector methods', () => {
      expect(mercariConnector.createListing).toBe(createListing);
      expect(mercariConnector.updateListing).toBe(updateListing);
      expect(mercariConnector.markSold).toBe(markSold);
      expect(mercariConnector.delist).toBe(delist);
      expect(mercariConnector.checkConnectionHealth).toBe(checkConnectionHealth);
    });
  });
});
