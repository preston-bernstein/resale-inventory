import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';

// mercari.ts never touches the DB directly (unlike poshmark.ts, which has a
// durable relist-cooldown/share-cap persistence layer) -- every mutating
// method's ban-risk mitigation is lib/connectors/pacing.ts's in-memory
// enforcePacing() instead. So this suite mocks all three of mercari.ts's
// external collaborators wholesale: the shared Playwright session harness
// (withSession/validateSessionReadOnly), lib/connections.ts#
// recordSuspensionSignal, and lib/connectors/pacing.ts#enforcePacing. No
// real browser is ever launched and no real DB row is ever required.
// Partial mock: keeps the real buildSessionHooks/fillClothingFields/
// uploadSortedPhotos (pure, no I/O -- shared by every Playwright-driven
// connector, see playwrightSession.ts) so this file's wiring/category-
// field/photo-upload assertions still exercise real behavior, while
// withSession/validateSessionReadOnly (the only exports that touch
// playwright/credentials) stay mocked.
vi.mock('@/lib/connectors/playwrightSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/playwrightSession')>();
  return {
    ...actual,
    withSession: vi.fn(),
    validateSessionReadOnly: vi.fn(),
  };
});

vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

vi.mock('@/lib/connectors/pacing', () => ({
  enforcePacing: vi.fn(),
}));

// Partial mock: keeps scrubSecrets' real implementation (so
// detectAndRecordSuspension's output is realistic) while still letting
// tests assert on the exact args it was called with -- needed to kill the
// mutant that swaps the empty secrets array literal for a non-empty one.
vi.mock('@/lib/connectors/scrub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/scrub')>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
});

import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { recordSuspensionSignal } from '@/lib/connections';
import { enforcePacing } from '@/lib/connectors/pacing';
import { scrubSecrets } from '@/lib/connectors/scrub';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyMercariSuspension,
  mercariConnector,
} from '@/lib/connectors/mercari';
import type { ListingInput } from '@/lib/connectors/types';

const mockWithSession = withSession as unknown as Mock;
const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;
const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;
const mockEnforcePacing = enforcePacing as unknown as Mock;
const mockScrubSecrets = scrubSecrets as unknown as Mock;

function buildListingInput(connectionId: string, itemId: string): ListingInput {
  return {
    itemId,
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    title: 'Test Shirt',
    priceCents: 2500,
    category: 'clothing',
    details: {
      brand: 'Acme',
      size_label: 'M',
      color: 'Blue',
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
    },
    photos: [],
  };
}

// Fake Playwright `Page` -- only used directly by the suspension-
// classification tests below, which invoke the SessionHooks#validateSession
// hook this file builds (captured from a mocked withSession/
// validateSessionReadOnly call) against it, simulating what
// playwrightSession.ts's real (non-mocked) implementation would pass in.
function makeFakePage(
  overrides: {
    content?: () => Promise<string>;
    url?: () => string;
    isVisible?: (selector: string) => Promise<boolean>;
  } = {},
) {
  return {
    goto: vi.fn(),
    fill: vi.fn(),
    check: vi.fn(),
    click: vi.fn(),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    url: overrides.url ?? (() => 'https://www.mercari.com/us/item/m12345678/'),
    content: overrides.content ?? (async () => ''),
    setInputFiles: vi.fn(),
    isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(false),
  };
}

/** Builds a book ListingInput -- buildListingInput() above is clothing-only. */
function buildBookListingInput(connectionId: string, itemId: string): ListingInput {
  return {
    itemId,
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    title: 'Test Book',
    priceCents: 1500,
    category: 'book',
    details: {
      isbn: '9780000000000',
      author: 'Jane Author',
      publisher: 'Acme Press',
      condition: 'Good',
    },
    photos: [],
  };
}

/**
 * Wires the mocked withSession to actually invoke the callback passed to it
 * (the real createListingAction/updateListingAction/markSoldAction/
 * delistAction closures) against `page` -- rather than just recording that
 * withSession was called. This is what lets the tests below exercise the
 * real Playwright-interaction code (navigation, fills, id extraction) that
 * every other test in this file deliberately never reaches.
 */
function wireRealSession(page: ReturnType<typeof makeFakePage>) {
  mockWithSession.mockImplementation(
    async (_tenantId: string, _connectionId: string, action: (p: unknown) => Promise<unknown>) => action(page),
  );
}

describe('mercari playwright action layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
