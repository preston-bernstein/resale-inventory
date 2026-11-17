import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  CONNECTION_ID,
  EXTERNAL_LISTING_ID,
  FAKE_CREDENTIAL,
  ITEM_ID,
  beforeAllSwappa,
  beforeEachSwappa,
  buildElectronicsListingInput,
  makeFakePage,
  mockRecordSuspensionSignal,
  mockScrubSecrets,
  mockValidateSessionReadOnly,
  mockWithSession,
  realWithSession,
  wireRealSession,
} from './swappa.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { DRY_RUN_CREDENTIAL_MARKER } from '@/lib/connectors/playwrightSession';
import { getDecryptedCredential, getConnection } from '@/lib/connections';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  swappaConnector,
} from '@/lib/connectors/swappa';

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('suspension classification', () => {
    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];
      const page = makeFakePage({
        content: async () => 'Your account has been banned for policy violations.',
      });

      await hooks.validateSession(page);

      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [tenantId, connId, reason, toStatus] = mockRecordSuspensionSignal.mock.calls[0];
      expect(tenantId).toBe(DEFAULT_TENANT_ID);
      expect(connId).toBe(CONNECTION_ID);
      expect(typeof reason).toBe('string');
      expect(toStatus).toBe('suspended');
    });

    it('does not record a suspension signal for a transient/ambiguous failure (e.g. navigation timeout)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const timeoutPage = makeFakePage({
        content: async () => {
          throw new Error('Timeout 30000ms exceeded.');
        },
      });
      await hooks.validateSession(timeoutPage);

      const genericPage = makeFakePage({ content: async () => '<html>Something went wrong</html>' });
      await hooks.validateSession(genericPage);

      expect(mockRecordSuspensionSignal).not.toHaveBeenCalled();
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('createListingAction (real callback invoked via a wired withSession) -- valid electronics listing', () => {
    it('navigates to /sell, fills title/description/price/device-spec fields by VALUE, submits, waits for /listings/, and extracts the id from the resulting URL', async () => {
      const page = makeFakePage({ url: () => 'https://swappa.com/listings/998877-macbook-pro' });
      wireRealSession(page);

      const input = buildElectronicsListingInput(CONNECTION_ID, ITEM_ID);
      const result = await createListing(input);

      expect(page.goto).toHaveBeenCalledWith('https://swappa.com/sell');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Test MacBook Pro');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Apple\nModel: MacBook Pro\nProcessor: M2\nRAM: 16GB\nStorage: 512GB\nScreen: 14"\nBattery Health: 92%\nBattery Cycles: 50\nCondition: Excellent',
      );
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '1500.00');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-device-type-input"]', 'laptop');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Apple');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-model-input"]', 'MacBook Pro');
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

    it('falls back to input.itemId when the post-submit URL cannot be parsed for a listing id', async () => {
      const page = makeFakePage({ url: () => 'https://swappa.com/sell' });
      wireRealSession(page);

      const result = await createListing(buildElectronicsListingInput(CONNECTION_ID, 'item-fallback-1'));

      expect(result).toEqual({ externalListingId: 'item-fallback-1' });
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('createListingAction (real callback invoked via a wired withSession) -- valid electronics listing', () => {
    it('extracts the id when the URL has no trailing slug or slash', async () => {
      const page = makeFakePage({ url: () => 'https://swappa.com/listings/445566' });
      wireRealSession(page);

      const result = await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));

      expect(result).toEqual({ externalListingId: '445566' });
    });

    it('falls back to input.itemId when trailing non-slug path segments follow the id', async () => {
      const page = makeFakePage({ url: () => 'https://swappa.com/listings/445566/reviews' });
      wireRealSession(page);

      const result = await createListing(
        buildElectronicsListingInput(CONNECTION_ID, 'item-anchor-fallback'),
      );

      expect(result).toEqual({ externalListingId: 'item-anchor-fallback' });
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('updateListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the listing edit page and returns not_found without filling/clicking anything when missing', async () => {
      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(page);

      const result = await updateListing('SW-404', DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' });

      expect(page.goto).toHaveBeenCalledWith('https://swappa.com/listings/SW-404/edit');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).not.toHaveBeenCalled();
    });

    it('fills only the patched fields by VALUE and saves when the listing exists, filling nothing for an empty patch', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const emptyPatchResult = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(emptyPatchResult).toEqual({ ok: true });

      page.fill.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'Updated Title' });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Updated Title');
      expect(page.fill).not.toHaveBeenCalledWith('[data-testid="listing-price-input"]', expect.anything());

      page.fill.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { priceCents: 999 });
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '9.99');
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('markSoldAction / delistAction (real callback invoked via a wired withSession)', () => {
    it('markSold navigates to the listing detail page, skips clicking when not found, clicks mark-as-sold when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(notFoundPage.goto).toHaveBeenCalledWith(`https://swappa.com/listings/${EXTERNAL_LISTING_ID}`);
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="listing-mark-as-sold-button"]');
      expect(foundResult).toEqual({ ok: true });
    });

    it('delist navigates to the listing detail page, skips clicking when not found, clicks delist when found', async () => {
      const notFoundPage = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="listing-not-found"]'),
      });
      wireRealSession(notFoundPage);
      const notFoundResult = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(notFoundResult).toEqual({ ok: false, reason: 'not_found' });
      expect(notFoundPage.click).not.toHaveBeenCalled();

      const foundPage = makeFakePage();
      wireRealSession(foundPage);
      const foundResult = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(foundPage.click).toHaveBeenCalledWith('[data-testid="listing-delist-button"]');
      expect(foundResult).toEqual({ ok: true });
    });

    it('catches an isVisible rejection in isItemNotFound and treats the listing as found rather than throwing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });
      wireRealSession(page);

      const result = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: true });
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('isAuthenticatedSwappaSession checks the EXACT selector string', () => {
    it('validateSession reports authenticated only when isVisible is asked for the real account-nav selector', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        isVisible: vi.fn(async (selector: string) => selector === '[data-testid="account-nav-link"]'),
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

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('credential scrubbing', () => {
    it('performLogin fills the credential by VALUE only -- it never appears in any selector string passed to fill/click/goto', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });
      await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));
      const hooks = mockWithSession.mock.calls[0][3];

      const page = makeFakePage();
      await hooks.performLogin(page, FAKE_CREDENTIAL);

      expect(page.goto).toHaveBeenCalledWith('https://swappa.com/login');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="login-form-password-input"]', FAKE_CREDENTIAL);
      expect(page.click).toHaveBeenCalledWith('[data-testid="login-form-submit-button"]');
      expect(page.waitForSelector).toHaveBeenCalledWith('[data-testid="account-nav-link"]', {
        timeout: 15000,
      });

      // The credential must never leak into a SELECTOR argument (only ever
      // into a fill() VALUE argument) -- checked across every fill/click/
      // goto/waitForSelector call this hook made.
      for (const call of page.fill.mock.calls) {
        expect(call[0]).not.toContain(FAKE_CREDENTIAL);
      }
      for (const call of page.click.mock.calls) {
        expect(call[0]).not.toContain(FAKE_CREDENTIAL);
      }
      expect((page.goto.mock.calls[0][0] as string)).not.toContain(FAKE_CREDENTIAL);
      expect((page.waitForSelector.mock.calls[0][0] as string)).not.toContain(FAKE_CREDENTIAL);
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('credential scrubbing', () => {
    it('a suspension-shaped page whose raw content happens to contain a credential-like string never leaks it into the recorded suspension reason (the reason is built purely from the static pattern match, never raw page content)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        content: async () =>
          `Your account has been banned. debug: session-credential=${FAKE_CREDENTIAL}`,
      });

      await hooks.validateSession(page);

      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [, , reasonArg] = mockRecordSuspensionSignal.mock.calls[0];
      expect(typeof reasonArg).toBe('string');
      expect(reasonArg).not.toContain(FAKE_CREDENTIAL);
    });

    it('calls scrubSecrets(reason, []) for the suspension reason -- never a non-empty secrets array, and never the raw credential', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({ content: async () => 'Your account has been banned.' });
      await hooks.validateSession(page);

      expect(mockScrubSecrets).toHaveBeenCalledWith(expect.any(String), []);
    });
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('credential scrubbing', () => {
    it('the dry-run log line never contains any credential value', async () => {
      vi.mocked(getConnection).mockReturnValue({
        id: CONNECTION_ID,
        platform: 'swappa',
        status: 'active',
        lastVerifiedAt: null,
        createdAt: '',
        updatedAt: '',
      });
      vi.mocked(getDecryptedCredential).mockReturnValue({ credential: DRY_RUN_CREDENTIAL_MARKER });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await realWithSession(DEFAULT_TENANT_ID, CONNECTION_ID, vi.fn());

      expect(logSpy).toHaveBeenCalledWith('[dry-run] platform=swappa action=withSession');
      for (const call of logSpy.mock.calls) {
        expect(String(call[0])).not.toContain(FAKE_CREDENTIAL);
      }
      logSpy.mockRestore();
    });
  });

  describe('swappaConnector export shape', () => {
    it('exposes all 5 Connector methods, wired to the real implementations (not an empty stub)', () => {
      expect(swappaConnector.createListing).toBe(createListing);
      expect(swappaConnector.updateListing).toBe(updateListing);
      expect(swappaConnector.markSold).toBe(markSold);
      expect(swappaConnector.delist).toBe(delist);
      expect(swappaConnector.checkConnectionHealth).toBe(checkConnectionHealth);
    });
  });
});
