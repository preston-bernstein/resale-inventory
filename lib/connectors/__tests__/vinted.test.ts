import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError, UnsupportedCategoryError } from '@/lib/connectors/types';
import type { ListingInput } from '@/lib/connectors/types';

// This suite mocks the shared Playwright session harness
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// lib/rateLimit.ts fixed-window bucket (that's pacing.test.ts's job). It
// also mocks lib/connections.ts#recordSuspensionSignal so the
// suspension-classification tests can assert on it directly. Unlike
// poshmark.test.ts, there's no persistence-layer describe block here --
// Vinted has no durable cooldown/share-cap tables to seed against a real
// scratch DB; enforcePacing is its entire ban-risk mitigation story, and
// that's a pure mock in this file.
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

vi.mock('@/lib/connectors/pacing', () => ({
  enforcePacing: vi.fn(),
}));

vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

// Partial mock: keeps scrubSecrets' real implementation available (restored
// after every vi.resetAllMocks() in beforeEach below, since resetAllMocks
// strips a vi.fn's implementation along with its call history) while still
// letting tests assert on the exact args it was called with -- needed to
// kill the mutant that swaps the empty secrets array literal for a
// non-empty one.
vi.mock('@/lib/connectors/scrub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/scrub')>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
});

import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import { recordSuspensionSignal } from '@/lib/connections';
import { scrubSecrets } from '@/lib/connectors/scrub';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyVintedSuspension,
  vintedConnector,
} from '@/lib/connectors/vinted';

const mockWithSession = withSession as unknown as Mock;
const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;
const mockEnforcePacing = enforcePacing as unknown as Mock;
const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;
const mockScrubSecrets = scrubSecrets as unknown as Mock;

let realScrubSecrets: (typeof import('@/lib/connectors/scrub'))['scrubSecrets'];

const CONNECTION_ID = 'vinted-conn-1';
const ITEM_ID = 'vinted-item-1';
const EXTERNAL_LISTING_ID = 'VINTED-LISTING-1';

function buildListingInput(): ListingInput {
  return {
    itemId: ITEM_ID,
    tenantId: DEFAULT_TENANT_ID,
    connectionId: CONNECTION_ID,
    title: 'Test Jacket',
    priceCents: 4500,
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
    url: overrides.url ?? (() => `https://www.vinted.com/items/${EXTERNAL_LISTING_ID}`),
    content: overrides.content ?? (async () => ''),
    setInputFiles: vi.fn(),
    isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(false),
  };
}

/** Builds a book ListingInput -- buildListingInput() above is clothing-only. */
function buildBookListingInput(): ListingInput {
  return {
    itemId: 'vinted-book-item-1',
    tenantId: DEFAULT_TENANT_ID,
    connectionId: CONNECTION_ID,
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
 * Wires the mocked withSession to actually invoke the callback passed to
 * it (the real createListingAction/updateListingAction/markSoldAction/
 * delistAction closures) against `page` -- rather than just recording that
 * withSession was called. This is what lets the tests below exercise the
 * real Playwright-interaction code (navigation, fills, id extraction) that
 * the rest of this file deliberately never reaches.
 */
function wireRealSession(page: ReturnType<typeof makeFakePage>) {
  mockWithSession.mockImplementation(
    async (_tenantId: string, _connectionId: string, action: (p: unknown) => Promise<unknown>) => action(page),
  );
}

describe('vinted playwright action layer', () => {
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/lib/connectors/scrub')>('@/lib/connectors/scrub');
    realScrubSecrets = actual.scrubSecrets;
  });

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) -- several tests below set
    // mockEnforcePacing's implementation to throw; clearAllMocks only
    // clears call history, leaving that throwing implementation to leak
    // into the next test. resetAllMocks restores every mock to a bare
    // vi.fn() with no implementation, so enforcePacing is a no-op again by
    // default. scrubSecrets is the one exception -- restore its real
    // passthrough implementation immediately after, since resetAllMocks
    // strips that too and several tests need the real scrubbing behavior.
    vi.resetAllMocks();
    mockScrubSecrets.mockImplementation(realScrubSecrets);
  });

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

    it('catches an isVisible rejection in isItemNotFound (via createListing\'s downstream update/markSold/delist path) and treats the item as found rather than throwing', async () => {
      const page = makeFakePage({ isVisible: vi.fn().mockRejectedValue(new Error('closed page')) });
      wireRealSession(page);

      const result = await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ ok: true });
    });
  });

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
