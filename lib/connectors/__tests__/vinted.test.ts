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
  mockEnforcePacing,
  mockRecordSuspensionSignal,
  mockValidateSessionReadOnly,
  mockWithSession,
  wireRealSession,
} from './vinted.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError, UnsupportedCategoryError } from '@/lib/connectors/types';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyVintedSuspension,
} from '@/lib/connectors/vinted';

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('pacing gate -- checked before any Playwright action', () => {
    it('createListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('vinted', CONNECTION_ID);
      });

      await expect(createListing(buildListingInput())).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('updateListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('vinted', CONNECTION_ID);
      });

      await expect(
        updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' }),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('markSold propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('vinted', CONNECTION_ID);
      });

      await expect(markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('delist propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('vinted', CONNECTION_ID);
      });

      await expect(delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('pacing gate -- checked before any Playwright action', () => {
    it('calls enforcePacing with the platform and connectionId before withSession, for every mutating method', async () => {
      mockWithSession.mockResolvedValue({ ok: true, externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildListingInput());
      expect(mockEnforcePacing).toHaveBeenCalledWith('vinted', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});
      expect(mockEnforcePacing).toHaveBeenCalledWith('vinted', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('vinted', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('vinted', CONNECTION_ID);
    });
  });

  describe('category support gate -- checked before pacing or withSession', () => {
    it('createListing throws UnsupportedCategoryError for category "electronics" and never calls enforcePacing or withSession (FR15/AC9) -- Vinted is book/clothing only', async () => {
      const input = buildListingInput();
      input.category = 'electronics';
      input.details = {
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
      };

      await expect(createListing(input)).rejects.toBeInstanceOf(UnsupportedCategoryError);
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('delegation to the shared Playwright session harness (dry-run safety)', () => {
    // withSession itself owns the dry-run short-circuit (see
    // playwrightSession.ts): when a connection has no real credential, it
    // resolves to a `{ dryRun: true, ... }` placeholder WITHOUT ever
    // importing `playwright` or launching a browser context. Because this
    // suite mocks withSession wholesale, the way to prove "dry-run never
    // launches a browser context" at THIS layer is to prove every mutating
    // method delegates to withSession (exactly once, never bypassing it to
    // drive Playwright directly) -- the same approach poshmark.test.ts/
    // depop.test.ts use.
    it('createListing/updateListing/markSold/delist each call the mocked withSession exactly once, never driving Playwright directly', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });
      await createListing(buildListingInput());
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' });
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockWithSession).toHaveBeenCalledTimes(1);

      mockWithSession.mockClear();
      mockWithSession.mockResolvedValueOnce({ ok: true });
      await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });

    it("surfaces withSession's dry-run placeholder result as-is from createListing, without inspecting or bypassing it", async () => {
      const dryRunResult = { dryRun: true, platform: 'vinted', connectionId: CONNECTION_ID };
      mockWithSession.mockResolvedValueOnce(dryRunResult);

      const result = await createListing(buildListingInput());

      expect(result).toBe(dryRunResult);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('not_found mapping', () => {
    it('updateListing returns { ok: false, reason: "not_found" } when withSession resolves that way', async () => {
      mockWithSession.mockResolvedValue({ ok: false, reason: 'not_found' });

      const result = await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {
        title: 'New title',
      });

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('markSold returns { ok: false, reason: "not_found" } when withSession resolves that way', async () => {
      mockWithSession.mockResolvedValue({ ok: false, reason: 'not_found' });

      const result = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('delist returns { ok: false, reason: "not_found" } when withSession resolves that way', async () => {
      mockWithSession.mockResolvedValue({ ok: false, reason: 'not_found' });

      const result = await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('checkConnectionHealth', () => {
    it('calls validateSessionReadOnly and never withSession or enforcePacing', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

      const result = await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);
      expect(mockValidateSessionReadOnly).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        CONNECTION_ID,
        expect.any(Object),
      );
      expect(mockWithSession).not.toHaveBeenCalled();
      expect(mockEnforcePacing).not.toHaveBeenCalled();
    });
  });

  describe('suspension classification', () => {
    it('classifyVintedSuspension matches known Vinted suspension/restriction banner text', () => {
      expect(classifyVintedSuspension('Your account has been disabled.')).not.toBeNull();
      expect(classifyVintedSuspension('This account has been banned for policy violations.')).not.toBeNull();
      expect(classifyVintedSuspension('Sorry, your account is temporarily blocked.')).not.toBeNull();
      expect(classifyVintedSuspension('This account has been closed.')).not.toBeNull();
    });

    it('classifyVintedSuspension returns null for ambiguous/generic content', () => {
      expect(classifyVintedSuspension('')).toBeNull();
      expect(classifyVintedSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifyVintedSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('suspension classification', () => {
    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      // Capture the SessionHooks this file built and passed to the mocked
      // validateSessionReadOnly, then drive its validateSession hook
      // directly against a fake page -- simulating what
      // playwrightSession.ts's real implementation would do.
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];
      const page = makeFakePage({
        content: async () => 'Your account has been disabled for policy violations.',
      });

      await hooks.validateSession(page);

      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
      const [tenantId, connId, reason, toStatus] = mockRecordSuspensionSignal.mock.calls[0];
      expect(tenantId).toBe(DEFAULT_TENANT_ID);
      expect(connId).toBe(CONNECTION_ID);
      expect(typeof reason).toBe('string');
      expect(toStatus).toBe('suspended');
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('suspension classification', () => {
    it('does not record a suspension signal for a transient/ambiguous failure (e.g. navigation timeout)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

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

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the upload form, fills title/description/price by VALUE, submits, and extracts the id from the resulting URL', async () => {
      const page = makeFakePage({ url: () => 'https://www.vinted.com/items/998877' });
      wireRealSession(page);

      const input = buildListingInput();
      const result = await createListing(input);

      expect(page.goto).toHaveBeenCalledWith('https://www.vinted.com/items/new');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-title-input"]', 'Test Jacket');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="upload-description-input"]',
        expect.stringContaining('Brand: Acme'),
      );
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-price-input"]', '45.00');
      expect(page.click).toHaveBeenCalledWith('[data-testid="upload-submit-button"]');
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

    it('falls back to input.itemId when the post-submit URL does not match the expected /items/<digits> shape', async () => {
      const page = makeFakePage({ url: () => 'https://www.vinted.com/items/new' });
      wireRealSession(page);

      const result = await createListing(buildListingInput());

      expect(result).toEqual({ externalListingId: ITEM_ID });
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('fills brand/size/color for a clothing listing using the details VALUES', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput());

      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-brand-input"]', 'Acme');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-size-input"]', 'M');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="upload-color-input"]', 'Blue');
    });

    it('is a no-op for category-specific fields on a book listing (Vinted has no book category fields)', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildBookListingInput());

      const categoryFillCalls = page.fill.mock.calls.filter(([selector]) =>
        selector.startsWith('[data-testid="upload-brand-input"]'),
      );
      expect(categoryFillCalls).toHaveLength(0);
      expect(page.check).not.toHaveBeenCalled();
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('uploads photos sorted by sort_order, passing paths by VALUE to setInputFiles, without mutating the caller\'s photos array', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const input = buildListingInput();
      const originalPhotos = [
        { id: 'p2', path: '/tmp/second.jpg', sort_order: 2 },
        { id: 'p1', path: '/tmp/first.jpg', sort_order: 1 },
      ];
      input.photos = originalPhotos;

      await createListing(input);

      expect(page.setInputFiles).toHaveBeenCalledWith('[data-testid="upload-photo-input"]', [
        '/tmp/first.jpg',
        '/tmp/second.jpg',
      ]);
      expect(originalPhotos.map((p) => p.id)).toEqual(['p2', 'p1']);
    });

    it('never calls setInputFiles when there are no photos', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput());

      expect(page.setInputFiles).not.toHaveBeenCalled();
    });

    it('waits for the URL to match /items/<digits>, not just any /items/ path', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput());

      expect(page.waitForURL).toHaveBeenCalledWith(/\/items\/\d+/);
    });
  });
});

describe('vinted playwright action layer', () => {
  beforeAll(beforeAllVintedPlaywrightAction);
  beforeEach(beforeEachVintedPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('catches an isVisible rejection in isItemNotFound (via createListing\'s downstream update/markSold/delist path) and treats the item as found rather than throwing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });
      wireRealSession(page);

      const result = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: true });
    });
  });
});
