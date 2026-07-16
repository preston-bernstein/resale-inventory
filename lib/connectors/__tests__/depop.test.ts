import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';
import type { ListingInput } from '@/lib/connectors/types';
import type { BookDetails } from '@/lib/types';

// This suite mocks the shared Playwright session harness
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// lib/rateLimit.ts fixed-window bucket (that's pacing.test.ts's job). It
// also mocks lib/connections.ts#recordSuspensionSignal so the
// suspension-classification tests can assert on it directly. Unlike
// poshmark.test.ts, there's no persistence-layer describe block here --
// Depop has no durable cooldown/share-cap tables to seed against a real
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

import { withSession, validateSessionReadOnly } from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import { recordSuspensionSignal } from '@/lib/connections';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifyDepopSuspension,
  depopConnector,
} from '@/lib/connectors/depop';

const mockWithSession = withSession as unknown as Mock;
const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;
const mockEnforcePacing = enforcePacing as unknown as Mock;
const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;

const CONNECTION_ID = 'depop-conn-1';
const ITEM_ID = 'depop-item-1';
const EXTERNAL_LISTING_ID = 'DEPOP-LISTING-1';

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

// Fake Playwright `Page`. Originally only used by the suspension-
// classification tests (invoking the captured SessionHooks#validateSession
// hook directly), now also handed to createListing/updateListing/markSold/
// delist's real action callback by mocking withSession to actually invoke
// it -- see the "(real withSession callback invoked)" describe blocks below
// -- so the real Playwright-interaction code inside those callbacks
// (navigation, value-based fills, id extraction) executes under test instead
// of being skipped as it was when withSession was mocked wholesale with no
// callback invocation.
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
    url: overrides.url ?? (() => `https://www.depop.com/products/${EXTERNAL_LISTING_ID}/`),
    content: overrides.content ?? (async () => ''),
    setInputFiles: vi.fn(),
    isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(true),
  };
}

function buildBookListingInput(): ListingInput {
  return {
    itemId: ITEM_ID,
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

describe('depop playwright action layer', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) -- several tests below set
    // mockEnforcePacing's implementation to throw; clearAllMocks only
    // clears call history, leaving that throwing implementation to leak
    // into the next test. resetAllMocks restores every mock to a bare
    // vi.fn() with no implementation, so enforcePacing is a no-op again by
    // default.
    vi.resetAllMocks();
  });

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

  // The describes below make mockWithSession actually INVOKE the action
  // callback passed to it (instead of just recording that it was called),
  // against a fake Playwright page -- so the real navigation/fill/click/
  // extraction logic inside createListingAction/updateListingAction/
  // markSoldAction/delistAction executes under test.
  describe('createListingAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

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

  describe('updateListingAction (real withSession callback invoked)', () => {
    let fakePage: ReturnType<typeof makeFakePage>;

    beforeEach(() => {
      fakePage = makeFakePage();
      mockWithSession.mockImplementation((_tenantId: string, _connectionId: string, action: (page: unknown) => unknown) =>
        action(fakePage),
      );
    });

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
