import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONNECTION_ID,
  EXTERNAL_LISTING_ID,
  beforeEachCreateListingActionRealWithSession,
  beforeEachDepopPlaywrightAction,
  buildListingInput,
  fakePage,
  makeFakePage,
  mockEnforcePacing,
  mockRecordSuspensionSignal,
  mockValidateSessionReadOnly,
  mockWithSession,
} from './depop.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError, UnsupportedCategoryError } from '@/lib/connectors/types';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyDepopSuspension,
} from '@/lib/connectors/depop';

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('pacing gate -- checked before any Playwright action', () => {
    it('createListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('depop', CONNECTION_ID);
      });

      await expect(createListing(buildListingInput())).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('updateListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('depop', CONNECTION_ID);
      });

      await expect(
        updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' }),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('markSold propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('depop', CONNECTION_ID);
      });

      await expect(markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('delist propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('depop', CONNECTION_ID);
      });

      await expect(delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('pacing gate -- checked before any Playwright action', () => {
    it('calls enforcePacing with the platform and connectionId before withSession, for every mutating method', async () => {
      mockWithSession.mockResolvedValue({ ok: true, externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildListingInput());
      expect(mockEnforcePacing).toHaveBeenCalledWith('depop', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});
      expect(mockEnforcePacing).toHaveBeenCalledWith('depop', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('depop', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('depop', CONNECTION_ID);
    });
  });

  describe('category support gate -- checked before pacing or withSession', () => {
    it('createListing throws UnsupportedCategoryError for category "electronics" and never calls enforcePacing or withSession (FR15/AC9) -- Depop is book/clothing only', async () => {
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

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('delegation to the shared Playwright session harness (dry-run safety)', () => {
    // withSession itself owns the dry-run short-circuit (see
    // playwrightSession.ts): when a connection has no real credential, it
    // resolves to a `{ dryRun: true, ... }` placeholder WITHOUT ever
    // importing `playwright` or launching a browser context. Because this
    // suite mocks withSession wholesale, the way to prove "dry-run never
    // launches a browser context" at THIS layer is to prove every mutating
    // method delegates to withSession (exactly once, never bypassing it to
    // drive Playwright directly) -- the same approach poshmark.test.ts uses.
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

    it('surfaces withSession\'s dry-run placeholder result as-is from createListing, without inspecting or bypassing it', async () => {
      const dryRunResult = { dryRun: true, platform: 'depop', connectionId: CONNECTION_ID };
      mockWithSession.mockResolvedValueOnce(dryRunResult);

      const result = await createListing(buildListingInput());

      expect(result).toBe(dryRunResult);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

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

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

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
    it('classifyDepopSuspension matches known Depop suspension/restriction banner text', () => {
      expect(classifyDepopSuspension('Your account has been suspended.')).not.toBeNull();
      expect(classifyDepopSuspension('This account has been banned for policy violations.')).not.toBeNull();
      expect(classifyDepopSuspension('Sorry, your account is temporarily restricted.')).not.toBeNull();
    });

    it('classifyDepopSuspension returns null for ambiguous/generic content', () => {
      expect(classifyDepopSuspension('')).toBeNull();
      expect(classifyDepopSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifyDepopSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });

    it('classifyDepopSuspension matches "violation"/"violated" without a trailing s (the s is optional, not required)', () => {
      expect(classifyDepopSuspension('Account disabled: violation of our terms.')).not.toBeNull();
      expect(classifyDepopSuspension('Account disabled: violated of our terms.')).not.toBeNull();
    });

    it('classifyDepopSuspension matches "depops terms" without an apostrophe (the apostrophe is optional, not required)', () => {
      expect(classifyDepopSuspension('Account disabled: violation of depops terms.')).not.toBeNull();
    });
  });
});

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

  describe('suspension classification', () => {
    it('classifyDepopSuspension matches across runs of multiple whitespace characters between words, never requiring exactly one space', () => {
      expect(classifyDepopSuspension('Your  account  has  been  disabled.')).not.toBeNull();
      expect(classifyDepopSuspension('Your  account  has  been  suspended.')).not.toBeNull();
      expect(classifyDepopSuspension('Your  account  has  been  banned.')).not.toBeNull();
      expect(classifyDepopSuspension('Your  account  is  temporarily  restricted.')).not.toBeNull();
      expect(classifyDepopSuspension('Your account has  been restricted.')).not.toBeNull();
      expect(
        classifyDepopSuspension('Account disabled due to violation  of  our  terms.'),
      ).not.toBeNull();
    });

    it('classifyDepopSuspension matches the "has been restricted" branch (not just "is restricted"), and matches "restricted" without the optional "temporarily"', () => {
      expect(classifyDepopSuspension('Your account has been restricted.')).not.toBeNull();
      expect(classifyDepopSuspension('Your account is restricted.')).not.toBeNull();
    });

    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });

      await checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      // Capture the SessionHooks this file built and passed to the mocked
      // validateSessionReadOnly, then drive its validateSession hook
      // directly against a fake page -- simulating what
      // playwrightSession.ts's real implementation would do.
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];
      const page = makeFakePage({
        content: async () => 'Your account has been suspended for policy violations.',
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

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);

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

describe('depop playwright action layer', () => {
  beforeEach(beforeEachDepopPlaywrightAction);


  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    beforeEach(beforeEachCreateListingActionRealWithSession);

    it('navigates to the create-listing page and fills title/description/price by VALUE, never by selector interpolation', async () => {
      const result = await createListing(buildListingInput());

      expect(fakePage.goto).toHaveBeenCalledWith('https://www.depop.com/products/create/');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Test Jacket');
      expect(fakePage.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        'Brand: Acme\nSize: M\nColor: Blue\nCondition: GUC',
      );
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '45.00');

      // Selector strings themselves must be the static literal -- the
      // tenant's title/description text must never be interpolated into a
      // selector string (spec requirement).
      for (const call of fakePage.fill.mock.calls) {
        expect(call[0]).not.toContain('Test Jacket');
        expect(call[0].startsWith('[data-testid="')).toBe(true);
      }
      expect(result).toEqual({ externalListingId: EXTERNAL_LISTING_ID });
    });

    it('fills clothing category fields (brand/size/color) by value and never checks the fallback "other" category', async () => {
      await createListing(buildListingInput());

      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Acme');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', 'M');
      expect(fakePage.fill).toHaveBeenCalledWith('[data-testid="listing-color-input"]', 'Blue');
      expect(fakePage.check).not.toHaveBeenCalled();
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

    it('skips the color fill entirely (never calls it, even with a falsy value) when color is null, and omits it from the description with no blank line', async () => {
      const input = buildListingInput();
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
