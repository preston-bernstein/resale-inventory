import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  beforeAllGrailed,
  beforeEachGrailed,
  buildBookListingInput,
  buildElectronicsListingInput,
  buildListingInput,
  makeFakePage,
  mockEnforcePacing,
  mockRecordSuspensionSignal,
  mockScrubSecrets,
  mockValidateSessionReadOnly,
  mockWithSession,
  wireRealSession,
} from './grailed.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyGrailedSuspension,
  grailedConnector,
} from '@/lib/connectors/grailed';

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('pacing gate', () => {
    it('createListing calls enforcePacing before withSession', async () => {
      mockWithSession.mockResolvedValue({ externalListingId: 'GR-1' });

      await createListing(buildListingInput('conn-1', 'item-1'));

      expect(mockEnforcePacing).toHaveBeenCalledWith('grailed', 'conn-1');
      expect(mockWithSession).toHaveBeenCalledTimes(1);
      // enforcePacing must be invoked strictly before withSession, per its
      // call order in the mock's invocation history.
      const pacingOrder = mockEnforcePacing.mock.invocationCallOrder[0];
      const sessionOrder = mockWithSession.mock.invocationCallOrder[0];
      expect(pacingOrder).toBeLessThan(sessionOrder);
    });

    it('propagates ConnectorRateLimitedError from createListing WITHOUT ever calling withSession', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('grailed', 'conn-1');
      });

      await expect(createListing(buildListingInput('conn-1', 'item-1'))).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('propagates ConnectorRateLimitedError from updateListing WITHOUT ever calling withSession', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('grailed', 'conn-1');
      });

      await expect(
        updateListing('GR-1', DEFAULT_TENANT_ID, 'conn-1', { title: 'New title' }),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockEnforcePacing).toHaveBeenCalledWith('grailed', 'conn-1');
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('pacing gate', () => {
    it('propagates ConnectorRateLimitedError from markSold WITHOUT ever calling withSession', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('grailed', 'conn-1');
      });

      await expect(markSold('GR-1', DEFAULT_TENANT_ID, 'conn-1')).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockEnforcePacing).toHaveBeenCalledWith('grailed', 'conn-1');
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('propagates ConnectorRateLimitedError from delist WITHOUT ever calling withSession', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('grailed', 'conn-1');
      });

      await expect(delist('GR-1', DEFAULT_TENANT_ID, 'conn-1')).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockEnforcePacing).toHaveBeenCalledWith('grailed', 'conn-1');
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('delegation to the shared Playwright session harness', () => {
    it('createListing/updateListing/markSold/delist each call the mocked withSession exactly once, never driving Playwright directly', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: 'GR-1' });
      await createListing(buildListingInput('conn-1', 'item-1'));
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await updateListing('GR-1', DEFAULT_TENANT_ID, 'conn-1', { title: 'New title' });
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await markSold('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await delist('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });

    it('dry-run mode (a withSession resolving with a dryRun payload) never launches a real browser context -- proven via delegation to the mocked withSession rather than a real browser assertion', async () => {
      // withSession itself owns dry-run detection (playwrightSession.ts) --
      // this connector never inspects the credential or decides dry-run
      // status itself, it just always delegates to withSession. So the way
      // to prove "dry-run never launches a browser" from this file's vantage
      // point is to prove createListing/etc never do anything BUT delegate
      // to withSession -- no direct playwright import, no bypass path.
      mockWithSession.mockResolvedValueOnce({ dryRun: true, platform: 'grailed', connectionId: 'conn-1' });

      const result = await createListing(buildListingInput('conn-1', 'item-1'));

      expect(result).toEqual({ dryRun: true, platform: 'grailed', connectionId: 'conn-1' });
      expect(mockWithSession).toHaveBeenCalledTimes(1);
      expect(mockWithSession).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        'conn-1',
        expect.any(Function),
        expect.any(Object),
      );
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('checkConnectionHealth', () => {
    it('calls validateSessionReadOnly and never enforcePacing or withSession', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

      const result = await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);
      expect(mockValidateSessionReadOnly).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        'conn-1',
        expect.any(Object),
      );
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });

  describe('suspension classification', () => {
    it('classifyGrailedSuspension matches known Grailed suspension/ban banner text', () => {
      expect(classifyGrailedSuspension('Your account has been banned.')).not.toBeNull();
      expect(classifyGrailedSuspension('Sorry, your account is temporarily suspended.')).not.toBeNull();
      expect(classifyGrailedSuspension('This account is under review.')).not.toBeNull();
    });

    it('classifyGrailedSuspension returns null for ambiguous/generic content', () => {
      expect(classifyGrailedSuspension('')).toBeNull();
      expect(classifyGrailedSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifyGrailedSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('suspension classification', () => {
    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');

      // Capture the SessionHooks this file built and passed to the mocked
      // validateSessionReadOnly, then drive its validateSession hook
      // directly against a fake page -- simulating what
      // playwrightSession.ts's real implementation would do.
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];
      const page = makeFakePage({
        content: async () => 'Your account has been banned for policy violations.',
      });

      await hooks.validateSession(page);

      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [tenantId, connId, reason, toStatus] = mockRecordSuspensionSignal.mock.calls[0];
      expect(tenantId).toBe(DEFAULT_TENANT_ID);
      expect(connId).toBe('conn-1');
      expect(typeof reason).toBe('string');
      // Scrubbed: the reason string must never contain any raw secret --
      // there's no credential in play here, but the reason is built purely
      // from the static pattern match/source text, not the raw page
      // content, so it can't leak anything from the (fake, harmless) page
      // body either.
      expect(reason).not.toContain('policy violations');
      expect(toStatus).toBe('suspended');
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('suspension classification', () => {
    it('does not record a suspension signal for a transient/ambiguous failure (e.g. navigation timeout, or unrelated content)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');

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

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the sell form, fills title/description/price by VALUE, submits, waits for /listings/, and extracts the id from the resulting URL', async () => {
      const page = makeFakePage({ url: () => 'https://www.grailed.com/listings/998877-cool-jacket' });
      wireRealSession(page);

      const input = buildListingInput('conn-1', 'item-1');
      const result = await createListing(input);

      expect(page.goto).toHaveBeenCalledWith('https://www.grailed.com/sell');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Test Jacket');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('Brand: Acme'),
      );
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '120.00');
      expect(page.click).toHaveBeenCalledWith('[data-testid="list-item-submit-button"]');
      expect(page.waitForURL).toHaveBeenCalledWith(/\/listings\//);
      expect(result).toEqual({ externalListingId: '998877' });

      // Selector safety: every fill() selector arg is a static data-testid
      // string -- never the tenant's title/description text interpolated
      // into the selector itself.
      for (const call of page.fill.mock.calls) {
        const [selector] = call;
        expect(selector).toMatch(/^\[data-testid="/);
        expect(selector).not.toContain(input.title);
      }
    });

    it('falls back to input.itemId when the post-submit URL does not match the expected /listings/<digits> shape', async () => {
      const page = makeFakePage({ url: () => 'https://www.grailed.com/sell' });
      wireRealSession(page);

      const result = await createListing(buildListingInput('conn-1', 'item-fallback-1'));

      expect(result).toEqual({ externalListingId: 'item-fallback-1' });
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('extracts the id when the URL has no trailing slug or slash', async () => {
      const page = makeFakePage({ url: () => 'https://www.grailed.com/listings/445566' });
      wireRealSession(page);

      const result = await createListing(buildListingInput('conn-1', 'item-1'));

      expect(result).toEqual({ externalListingId: '445566' });
    });

    it('falls back to input.itemId when trailing non-slug path segments follow the id', async () => {
      const page = makeFakePage({ url: () => 'https://www.grailed.com/listings/445566/reviews' });
      wireRealSession(page);

      const result = await createListing(buildListingInput('conn-1', 'item-anchor-fallback'));

      expect(result).toEqual({ externalListingId: 'item-anchor-fallback' });
    });

    it('fills brand/size/color for a clothing listing using the details VALUES', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput('conn-1', 'item-1'));

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Acme');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', 'M');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-color-input"]', 'Black');
    });

    it('is a no-op for category-specific fields on a book listing', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildBookListingInput('conn-1', 'item-book-1'));

      const categoryFillCalls = page.fill.mock.calls.filter(([selector]) =>
        selector.startsWith('[data-testid="listing-brand-input"]'),
      );
      expect(categoryFillCalls).toHaveLength(0);
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('creates an electronics listing with brand/model/processor/condition in description, excluding book/clothing fields', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildElectronicsListingInput('conn-1', 'item-elec-1'));

      const descCalls = page.fill.mock.calls.filter((call) => call[0] === '[data-testid="listing-description-input"]');
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

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('updateListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the listing edit page and returns not_found without filling/clicking anything when missing', async () => {
      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(page);

      const result = await updateListing('GR-404', DEFAULT_TENANT_ID, 'conn-1', { title: 'New title' });

      expect(page.goto).toHaveBeenCalledWith('https://www.grailed.com/listings/GR-404/edit');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).not.toHaveBeenCalled();
    });

    it('fills only the patched fields by VALUE and saves when the listing exists, filling nothing for an empty patch', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const emptyPatchResult = await updateListing('GR-1', DEFAULT_TENANT_ID, 'conn-1', {});
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(emptyPatchResult).toEqual({ ok: true });

      page.fill.mockClear();
      await updateListing('GR-1', DEFAULT_TENANT_ID, 'conn-1', { title: 'Updated Title' });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Updated Title');
      expect(page.fill).not.toHaveBeenCalledWith('[data-testid="listing-price-input"]', expect.anything());

      page.fill.mockClear();
      await updateListing('GR-1', DEFAULT_TENANT_ID, 'conn-1', { priceCents: 999 });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '9.99');
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('markSoldAction / delistAction (real callback invoked via a wired withSession)', () => {
    it('markSold navigates to the listing detail page, skips clicking when not found, clicks mark-as-sold when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await markSold('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(notFoundPage.goto).toHaveBeenCalledWith('https://www.grailed.com/listings/GR-1');
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await markSold('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="listing-mark-as-sold-button"]');
      expect(foundResult).toEqual({ ok: true });
    });

    it('delist navigates to the listing detail page, skips clicking when not found, clicks delist when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await delist('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await delist('GR-1', DEFAULT_TENANT_ID, 'conn-1');
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="listing-delist-button"]');
      expect(foundResult).toEqual({ ok: true });
    });

    it('catches an isVisible rejection in isItemNotFound and treats the listing as found rather than throwing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });
      wireRealSession(page);

      const result = await delist('GR-1', DEFAULT_TENANT_ID, 'conn-1');

      expect(result).toEqual({ ok: true });
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('suspension regex: \\s+ (one-or-more) vs \\s (exactly-one) boundary cases', () => {
    it('grailed pattern 1 (account has been banned) matches with double spaces at every gap', () => {
      expect(classifyGrailedSuspension('Your account  has  been  banned.')).not.toBeNull();
    });

    it('grailed pattern 2 (your account is/has been ... suspended) matches with double spaces at every gap', () => {
      expect(
        classifyGrailedSuspension('your  account  has  been  temporarily  suspended for review.'),
      ).not.toBeNull();
    });

    it('grailed pattern 2 matches without "temporarily" -- that group is optional, not mandatory', () => {
      expect(classifyGrailedSuspension('Your account is suspended.')).not.toBeNull();
    });

    it('grailed pattern 3 (account is under review) matches with double spaces at every gap', () => {
      expect(classifyGrailedSuspension('account  is  under  review')).not.toBeNull();
    });

    it('grailed pattern 4 (violated of our/grailed\'s terms/polic) matches with double spaces at every gap', () => {
      expect(classifyGrailedSuspension('This is a violation  of  our  terms of service.')).not.toBeNull();
    });

    it('grailed pattern 4 matches "graileds" (no apostrophe) -- the apostrophe is optional, not mandatory', () => {
      expect(classifyGrailedSuspension('This is a violation of graileds policy.')).not.toBeNull();
    });
  });

  describe('detectAndRecordSuspension scrubs with an empty secrets list', () => {
    it('calls scrubSecrets(reason, []) -- never a non-empty secrets array', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ content: async () => 'Your account has been banned.' });
      await hooks.validateSession(page);

      expect(mockScrubSecrets).toHaveBeenCalledWith(expect.any(String), []);
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('isAuthenticatedGrailedSession checks the EXACT selector string', () => {
    it('validateSession reports authenticated only when isVisible is asked for the real sell-nav selector', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="sell-nav-link"]'),
      });

      const authenticated = await hooks.validateSession(page);
      expect(authenticated).toBe(true);
    });

    it('catches an isVisible rejection and treats the session as unauthenticated rather than throwing', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-1');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });

      await expect(hooks.validateSession(page)).resolves.toBe(false);
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('performLogin session hook (invoked directly against a fake page)', () => {
    it('navigates to /login, fills the credential VALUE, submits, and waits for the sell-nav selector', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      await createListing(buildListingInput('conn-1', 'item-1'));
      const hooks = mockWithSession.mock.calls[0][3];

      const loginPage = makeFakePage();
      await hooks.performLogin(loginPage, 'super-secret-password');

      expect(loginPage.goto).toHaveBeenCalledWith('https://www.grailed.com/login');
      expect(loginPage.fill).toHaveBeenCalledWith(
        '[data-testid="login-form-password-input"]',
        'super-secret-password',
      );
      expect(loginPage.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(loginPage.waitForSelector).toHaveBeenCalledWith('[data-testid="sell-nav-link"]', {
        timeout: 15000,
      });
    });
  });

  describe('buildListingDescription (exercised via createListing)', () => {
    it('joins all present clothing fields with newlines, in brand/size/color/condition order', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput('conn-1', 'item-1'));

      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nColor: Black\nCondition: GUC',
      );
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('buildListingDescription (exercised via createListing)', () => {
    it('omits a clothing field entirely (no blank line) when its value is null', async () => {
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

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

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

    it('never fills the color field at all when color is null (guarded by `if (d.color)`)', async () => {
      const page = makeFakePage();
      wireRealSession(page);
      const input = buildListingInput('conn-1', 'item-1');
      (input.details as { color: string | null }).color = null;

      await createListing(input);

      const colorFillCalls = page.fill.mock.calls.filter(
        ([selector]) => selector === '[data-testid="listing-color-input"]',
      );
      expect(colorFillCalls).toHaveLength(0);
    });
  });
});

describe('grailed connector', () => {
  beforeAll(beforeAllGrailed);
  beforeEach(beforeEachGrailed);

  describe('grailedConnector', () => {
    it('exposes all 5 Connector methods', () => {
      expect(grailedConnector.createListing).toBe(createListing);
      expect(grailedConnector.updateListing).toBe(updateListing);
      expect(grailedConnector.markSold).toBe(markSold);
      expect(grailedConnector.delist).toBe(delist);
      expect(grailedConnector.checkConnectionHealth).toBe(checkConnectionHealth);
    });
  });
});
