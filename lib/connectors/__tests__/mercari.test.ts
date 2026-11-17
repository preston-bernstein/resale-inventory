import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beforeEachMercariPlaywrightAction,
  buildBookListingInput,
  buildListingInput,
  makeFakePage,
  mockEnforcePacing,
  mockRecordSuspensionSignal,
  mockValidateSessionReadOnly,
  mockWithSession,
  wireRealSession,
} from './mercari.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyMercariSuspension,
} from '@/lib/connectors/mercari';

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('dry-run / delegation to the shared Playwright session harness', () => {
    it('createListing/updateListing/markSold/delist never launch a browser context themselves -- each delegates to the mocked withSession exactly once', async () => {
      const connectionId = 'conn-1';
      const itemId = 'item-1';
      const externalListingId = 'MERC-DELEGATE-1';

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

    it('dry-run mode never launches a browser context -- withSession (mocked here, the sole choke point for playwright/browser access) resolving a dry-run-shaped result is exactly what mercari.ts sees and returns, with no separate browser-launch path of its own', async () => {
      const connectionId = 'conn-dry-run';
      const itemId = 'item-dry-run';
      const dryRunResult = { dryRun: true, platform: 'mercari', connectionId };
      mockWithSession.mockResolvedValueOnce(dryRunResult);

      const result = await createListing(buildListingInput(connectionId, itemId));

      expect(result).toBe(dryRunResult);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('pacing gate', () => {
    it('createListing propagates ConnectorRateLimitedError from enforcePacing and never calls withSession', async () => {
      const connectionId = 'conn-rate-limited';
      const itemId = 'item-1';
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('mercari', connectionId);
      });

      let caught: unknown;
      try {
        await createListing(buildListingInput(connectionId, itemId));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockEnforcePacing).toHaveBeenCalledWith('mercari', connectionId);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('updateListing propagates ConnectorRateLimitedError and never calls withSession', async () => {
      const connectionId = 'conn-rate-limited';
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('mercari', connectionId);
      });

      await expect(
        updateListing('MERC-1', DEFAULT_TENANT_ID, connectionId, { title: 'New title' }),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('markSold propagates ConnectorRateLimitedError and never calls withSession', async () => {
      const connectionId = 'conn-rate-limited';
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('mercari', connectionId);
      });

      await expect(markSold('MERC-1', DEFAULT_TENANT_ID, connectionId)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('pacing gate', () => {
    it('delist propagates ConnectorRateLimitedError and never calls withSession', async () => {
      const connectionId = 'conn-rate-limited';
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('mercari', connectionId);
      });

      await expect(delist('MERC-1', DEFAULT_TENANT_ID, connectionId)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('calls enforcePacing before withSession on a successful call', async () => {
      const connectionId = 'conn-ok';
      const itemId = 'item-1';
      const callOrder: string[] = [];
      mockEnforcePacing.mockImplementation(() => {
        callOrder.push('enforcePacing');
      });
      mockWithSession.mockImplementation(async () => {
        callOrder.push('withSession');
        return { externalListingId: 'MERC-NEW-1' };
      });

      await createListing(buildListingInput(connectionId, itemId));

      expect(callOrder).toEqual(['enforcePacing', 'withSession']);
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('checkConnectionHealth', () => {
    it('calls validateSessionReadOnly and never enforcePacing or withSession', async () => {
      const connectionId = 'conn-health';
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });

      const result = await checkConnectionHealth(DEFAULT_TENANT_ID, connectionId);

      expect(result).toEqual({ healthy: true });
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);
      expect(mockValidateSessionReadOnly).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        connectionId,
        expect.any(Object),
      );
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });
  });

  describe('suspension classification', () => {
    it('classifyMercariSuspension matches known Mercari suspension/restriction banner text', () => {
      expect(classifyMercariSuspension('Your account has been deactivated.')).not.toBeNull();
      expect(classifyMercariSuspension('Sorry, your account is temporarily restricted.')).not.toBeNull();
      expect(classifyMercariSuspension('This account has been suspended for violations of our terms.')).not.toBeNull();
    });

    it('classifyMercariSuspension returns null for ambiguous/generic content', () => {
      expect(classifyMercariSuspension('')).toBeNull();
      expect(classifyMercariSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifyMercariSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('suspension classification', () => {
    it('records exactly one suspension signal, with a scrubbed reason, when the session hooks see a suspension-shaped page', async () => {
      const connectionId = 'conn-suspended';
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
      // Not a raw, unprocessed banner string -- scrubSecrets ran over it.
      expect(reason).not.toBe('Your account has been deactivated for policy violations.');
      expect(toStatus).toBe('suspended');
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('suspension classification', () => {
    it('does not record a suspension signal for a transient/ambiguous failure (e.g. navigation timeout, or unrelated content)', async () => {
      const connectionId = 'conn-transient';
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

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the sell form, fills title/description/price by VALUE, submits, and extracts the id from the resulting URL', async () => {
      const page = makeFakePage({ url: () => 'https://www.mercari.com/us/item/m99887766/' });
      wireRealSession(page);

      const input = buildListingInput('conn-1', 'item-1');
      const result = await createListing(input);

      expect(page.goto).toHaveBeenCalledWith('https://www.mercari.com/sell/');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Test Shirt');
      expect(page.fill).toHaveBeenCalledWith(
        '[data-testid="listing-description-input"]',
        expect.stringContaining('Brand: Acme'),
      );
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '25.00');
      expect(page.click).toHaveBeenCalledWith('[data-testid="list-item-submit-button"]');
      expect(result).toEqual({ externalListingId: 'm99887766' });

      // Selector safety: every fill() selector arg is a static data-testid
      // string -- never the tenant's title/description text interpolated
      // into the selector itself.
      for (const call of page.fill.mock.calls) {
        const [selector] = call;
        expect(selector).toMatch(/^\[data-testid="/);
        expect(selector).not.toContain(input.title);
      }
    });

    it('falls back to input.itemId when the post-submit URL does not match the expected /item/<id>/ shape', async () => {
      const page = makeFakePage({ url: () => 'https://www.mercari.com/sell/' });
      wireRealSession(page);

      const input = buildListingInput('conn-1', 'item-fallback-1');
      const result = await createListing(input);

      expect(result).toEqual({ externalListingId: 'item-fallback-1' });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('fills brand/size/color for a clothing listing using the details VALUES, never a book checkbox', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput('conn-1', 'item-1'));

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-brand-input"]', 'Acme');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-size-input"]', 'M');
      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-color-input"]', 'Blue');
      expect(page.check).not.toHaveBeenCalled();
    });

    it('checks the Books category checkbox for a book listing instead of filling brand/size/color', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildBookListingInput('conn-1', 'item-book-1'));

      expect(page.check).toHaveBeenCalledWith('[data-testid="listing-category-books"]');
      expect(page.fill).not.toHaveBeenCalledWith('[data-testid="listing-brand-input"]', expect.anything());
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('createListingAction (real callback invoked via a wired withSession)', () => {
    it('uploads photos sorted by sort_order, passing paths by VALUE to setInputFiles, WITHOUT mutating the caller\'s photos array', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const input = buildListingInput('conn-1', 'item-1');
      const originalPhotos = [
        { id: 'p2', path: '/tmp/second.jpg', sort_order: 2 },
        { id: 'p1', path: '/tmp/first.jpg', sort_order: 1 },
      ];
      input.photos = originalPhotos;

      await createListing(input);

      expect(page.setInputFiles).toHaveBeenCalledWith('[data-testid="listing-photo-upload-input"]', [
        '/tmp/first.jpg',
        '/tmp/second.jpg',
      ]);
      // The `.slice()` before `.sort()` must produce a defensive copy --
      // the caller's own array/object references are never reordered or
      // mutated in place.
      expect(originalPhotos).toBe(input.photos);
      expect(originalPhotos.map((p) => p.id)).toEqual(['p2', 'p1']);
    });

    it('never calls setInputFiles when there are no photos', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await createListing(buildListingInput('conn-1', 'item-1'));

      expect(page.setInputFiles).not.toHaveBeenCalled();
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('updateListingAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the item edit page and returns not_found without filling/clicking anything when the item is missing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
      wireRealSession(page);

      const result = await updateListing('MERC-404', DEFAULT_TENANT_ID, 'conn-1', { title: 'New title' });

      expect(page.goto).toHaveBeenCalledWith('https://www.mercari.com/us/sell/edit/MERC-404/');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.fill).not.toHaveBeenCalled();
      expect(page.click).not.toHaveBeenCalled();
    });

    it('fills only the patched fields by VALUE and saves when the item exists', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const result = await updateListing('MERC-1', DEFAULT_TENANT_ID, 'conn-1', { title: 'Updated Title' });

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-title-input"]', 'Updated Title');
      expect(page.fill).not.toHaveBeenCalledWith('[data-testid="listing-price-input"]', expect.anything());
      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-save-button"]');
      expect(result).toEqual({ ok: true });
    });

    it('fills price when patched, formatted as dollars from priceCents', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      await updateListing('MERC-1', DEFAULT_TENANT_ID, 'conn-1', { priceCents: 999 });

      expect(page.fill).toHaveBeenCalledWith('[data-testid="listing-price-input"]', '9.99');
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('markSoldAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the item detail page and returns not_found without clicking when the item is missing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
      wireRealSession(page);

      const result = await markSold('MERC-404', DEFAULT_TENANT_ID, 'conn-1');

      expect(page.goto).toHaveBeenCalledWith('https://www.mercari.com/us/item/MERC-404/');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.click).not.toHaveBeenCalled();
    });

    it('clicks mark-as-sold and returns ok when the item exists', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const result = await markSold('MERC-1', DEFAULT_TENANT_ID, 'conn-1');

      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-mark-as-sold-button"]');
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('delistAction (real callback invoked via a wired withSession)', () => {
    it('navigates to the item detail page and returns not_found without clicking when the item is missing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockResolvedValue(true) });
      wireRealSession(page);

      const result = await delist('MERC-404', DEFAULT_TENANT_ID, 'conn-1');

      expect(page.goto).toHaveBeenCalledWith('https://www.mercari.com/us/item/MERC-404/');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(page.click).not.toHaveBeenCalled();
    });

    it('clicks delist and returns ok when the item exists', async () => {
      const page = makeFakePage();
      wireRealSession(page);

      const result = await delist('MERC-1', DEFAULT_TENANT_ID, 'conn-1');

      expect(page.click).toHaveBeenCalledWith('[data-testid="listing-delist-button"]');
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('suspension classification -- regex boundary cases', () => {
    it('matches "restricted" without "temporarily" (the group is optional)', () => {
      expect(classifyMercariSuspension('Your account is restricted.')).not.toBeNull();
    });

    it('matches "locked" as a synonym alongside restricted/suspended', () => {
      expect(classifyMercariSuspension('Your account has been temporarily locked.')).not.toBeNull();
    });

    it('matches the bare "account suspension" phrase (pattern 3), independent of the "your account is/has been" phrasing', () => {
      expect(classifyMercariSuspension('Reason: account suspension')).not.toBeNull();
    });

    it('matches "violation" (singular, no -s) and "policy" for the terms/polic pattern', () => {
      expect(classifyMercariSuspension('This is a violation of our policy.')).not.toBeNull();
    });

    it('matches "mercari\'s terms" with the apostrophe present', () => {
      expect(classifyMercariSuspension("This is a violation of mercari's terms of service.")).not.toBeNull();
    });

    it('does NOT match "account closed" -- Mercari patterns cover deactivated/disabled, not closed', () => {
      expect(classifyMercariSuspension('Your account has been closed by you.')).toBeNull();
    });

    it('does NOT match generic "restricted" without "your account" context', () => {
      expect(classifyMercariSuspension('This item is restricted in your region.')).toBeNull();
    });

    it('does NOT match "terms" alone without a preceding violation phrase', () => {
      expect(classifyMercariSuspension('Please review our terms and policies.')).toBeNull();
    });
  });
});

describe('mercari playwright action layer', () => {
  beforeEach(beforeEachMercariPlaywrightAction);

  describe('validateSession hook runs the suspension check independent of auth result', () => {
    it('records a suspension signal even when isAuthenticatedMercariSession would report true (account nav still visible)', async () => {
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: false });
      await checkConnectionHealth(DEFAULT_TENANT_ID, 'conn-both');
      const hooks = mockValidateSessionReadOnly.mock.calls[0][2];

      const page = makeFakePage({
        isVisible: vi.fn().mockResolvedValue(true), // nav chrome renders (looks "authenticated")
        content: async () => 'Your account has been deactivated for policy violations.',
      });

      const authenticated = await hooks.validateSession(page);

      expect(authenticated).toBe(true);
      expect(mockRecordSuspensionSignal).toHaveBeenCalledTimes(1);
    });
  });
});
