import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import {
  ConnectorRateLimitedError,
  ConnectorGatingError,
  UnsupportedCategoryError,
} from '@/lib/connectors/types';
import type { ListingInput } from '@/lib/connectors/types';

// This suite mocks the shared Playwright session harness
// (playwrightSession.ts's withSession/validateSessionReadOnly) and the
// pacing gate (pacing.ts's enforcePacing) wholesale -- it never launches a
// real browser or imports `playwright`, and never exercises the real
// in-memory rate-limit bucket (that's pacing.test.ts's job). It also mocks
// lib/connections.ts#recordSuspensionSignal/getDecryptedCredential/
// getConnection/rotateCredential (the latter three only used by the
// "dry-run behavior" describe block below, which drives the REAL
// playwrightSession.ts#withSession directly via vi.importActual to prove
// Swappa's own dry-run log line, without ever touching this file's mocked
// withSession). Like grailed.test.ts/vinted.test.ts (this file's structural
// model, since swappa.ts was built to mirror grailed.ts), there's no
// persistence-layer describe block here -- Swappa has no durable cooldown/
// share-cap tables to seed against a real scratch DB; enforcePacing is its
// entire ban-risk mitigation story, and that's a pure mock in this file.
// Partial mock: keeps the real buildSessionHooks/isElementVisible (pure, no
// I/O -- shared by every Playwright-driven connector, see
// playwrightSession.ts) so this file's wiring/suspension-check assertions
// still exercise real behavior, while withSession/validateSessionReadOnly
// (the only exports that touch playwright/credentials) stay mocked.
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

// getDecryptedCredential/getConnection/rotateCredential are only exercised
// directly by the "dry-run behavior" describe block (against the REAL
// withSession); every other describe block in this file only needs
// recordSuspensionSignal mocked.
vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
  getDecryptedCredential: vi.fn(),
  getConnection: vi.fn(),
  rotateCredential: vi.fn(),
}));

// Mocked so the "gating" describe block can drive buildConnector('swappa',
// swappaConnector) (lib/connectors/gate.ts) against a controllable
// consent/connection-status result, without hitting the real DB-backed
// lib/automationGate.ts/lib/consent.ts, and without recordListingCreated
// touching the real item_platforms table.
vi.mock('@/lib/automationGate', () => ({
  assertCanAutomate: vi.fn(),
}));
vi.mock('@/lib/connectors/itemPlatformsWrite', () => ({
  recordListingCreated: vi.fn(),
}));

// Partial mock: keeps scrubSecrets' real implementation available (restored
// after every vi.resetAllMocks() in beforeEach below, since resetAllMocks
// strips a vi.fn's implementation along with its call history) while still
// letting tests assert on the exact args it was called with -- needed to
// kill the mutant that swaps the empty secrets array literal for a
// non-empty one (same convention as grailed.test.ts/vinted.test.ts).
vi.mock('@/lib/connectors/scrub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/scrub')>();
  return { ...actual, scrubSecrets: vi.fn(actual.scrubSecrets) };
});

import {
  withSession,
  validateSessionReadOnly,
  DRY_RUN_CREDENTIAL_MARKER,
} from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import { recordSuspensionSignal, getDecryptedCredential, getConnection, rotateCredential } from '@/lib/connections';
import { scrubSecrets } from '@/lib/connectors/scrub';
import { assertCanAutomate } from '@/lib/automationGate';
import { recordListingCreated } from '@/lib/connectors/itemPlatformsWrite';
import { buildConnector } from '@/lib/connectors/gate';
import {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
  classifySwappaSuspension,
  swappaConnector,
} from '@/lib/connectors/swappa';

const mockWithSession = withSession as unknown as Mock;
const mockValidateSessionReadOnly = validateSessionReadOnly as unknown as Mock;
const mockEnforcePacing = enforcePacing as unknown as Mock;
const mockRecordSuspensionSignal = recordSuspensionSignal as unknown as Mock;
const mockScrubSecrets = scrubSecrets as unknown as Mock;
const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;
const mockRecordListingCreated = recordListingCreated as unknown as Mock;

let realScrubSecrets: (typeof import('@/lib/connectors/scrub'))['scrubSecrets'];
let realWithSession: (typeof import('@/lib/connectors/playwrightSession'))['withSession'];

const CONNECTION_ID = 'swappa-conn-1';
const ITEM_ID = 'swappa-item-1';
const EXTERNAL_LISTING_ID = 'SWAPPA-LISTING-1';

/** Electronics ListingInput -- Swappa is electronics-only. */
function buildElectronicsListingInput(connectionId: string, itemId: string): ListingInput {
  return {
    itemId,
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    title: 'Test MacBook Pro',
    priceCents: 150000,
    category: 'electronics',
    details: {
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
    },
    photos: [],
  };
}

/** Clothing ListingInput -- used only by the category-rejection tests below. */
function buildClothingListingInput(connectionId: string, itemId: string): ListingInput {
  return {
    itemId,
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
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

/** Book ListingInput -- used only by the category-rejection tests below. */
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

// Fake Playwright `Page` -- used both by the suspension-classification tests
// (invoking the SessionHooks#validateSession hook this file builds) and by
// the "real callback invoked via a wired withSession" describe blocks below,
// simulating what playwrightSession.ts's real (non-mocked) implementation
// would pass in.
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
    url: overrides.url ?? (() => `https://swappa.com/listings/${EXTERNAL_LISTING_ID}`),
    content: overrides.content ?? (async () => ''),
    setInputFiles: vi.fn(),
    isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(false),
  };
}

/**
 * Wires the mocked withSession to actually invoke the callback passed to it
 * (the real createListingAction/updateListingAction/markSoldAction/
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

describe('swappa connector', () => {
  beforeAll(async () => {
    const scrubActual = await vi.importActual<typeof import('@/lib/connectors/scrub')>('@/lib/connectors/scrub');
    realScrubSecrets = scrubActual.scrubSecrets;

    const sessionActual = await vi.importActual<typeof import('@/lib/connectors/playwrightSession')>(
      '@/lib/connectors/playwrightSession',
    );
    realWithSession = sessionActual.withSession;
  });

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) -- several tests below set
    // mockEnforcePacing/mockAssertCanAutomate's implementation to throw or
    // return a fixed value; clearAllMocks only clears call history, leaving
    // that implementation to leak into the next test. resetAllMocks
    // restores every mock to a bare vi.fn() with no implementation, so
    // enforcePacing/assertCanAutomate are no-ops/undefined again by
    // default. scrubSecrets is the one exception -- restore its real
    // passthrough implementation immediately after, since resetAllMocks
    // strips that too and several tests need the real scrubbing behavior.
    vi.resetAllMocks();
    mockScrubSecrets.mockImplementation(realScrubSecrets);
  });

  describe('pacing gate -- checked before any Playwright action', () => {
    it('createListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('swappa', CONNECTION_ID);
      });

      await expect(
        createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID)),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('updateListing propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('swappa', CONNECTION_ID);
      });

      await expect(
        updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'New title' }),
      ).rejects.toBeInstanceOf(ConnectorRateLimitedError);
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('markSold propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('swappa', CONNECTION_ID);
      });

      await expect(markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('delist propagates ConnectorRateLimitedError and never calls withSession when paced out', async () => {
      mockEnforcePacing.mockImplementation(() => {
        throw new ConnectorRateLimitedError('swappa', CONNECTION_ID);
      });

      await expect(delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorRateLimitedError,
      );
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('calls enforcePacing with the platform and connectionId before withSession, for every mutating method', async () => {
      mockWithSession.mockResolvedValue({ ok: true, externalListingId: EXTERNAL_LISTING_ID });

      await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, {});
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);

      mockEnforcePacing.mockClear();
      await delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID);
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);
    });
  });

  describe('category rejection (electronics-only marketplace, FR15/AC9)', () => {
    it('createListing throws UnsupportedCategoryError for category "book" as its FIRST action, never calling enforcePacing or withSession', async () => {
      await expect(
        createListing(buildBookListingInput(CONNECTION_ID, 'item-book-1')),
      ).rejects.toBeInstanceOf(UnsupportedCategoryError);
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('createListing throws UnsupportedCategoryError for category "clothing", never calling enforcePacing or withSession', async () => {
      await expect(
        createListing(buildClothingListingInput(CONNECTION_ID, 'item-clothing-1')),
      ).rejects.toMatchObject({ platform: 'swappa', category: 'clothing' });
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('createListing succeeds past the category gate for category "electronics" (the one category Swappa supports)', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });

      const result = await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));

      expect(result).toEqual({ externalListingId: EXTERNAL_LISTING_ID });
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);
    });
  });

  describe('gating (lib/connectors/gate.ts#buildConnector wrap) -- no network call when consent is invalid or status is not "active"', () => {
    it('createListing throws ConnectorGatingError(missing_consent) and never calls enforcePacing/withSession when consent is missing', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'consent_required' });
      const gated = buildConnector('swappa', swappaConnector);

      const err = await gated
        .createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConnectorGatingError);
      expect((err as ConnectorGatingError).kind).toBe('missing_consent');
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
      expect(mockRecordListingCreated).not.toHaveBeenCalled();
    });

    it('createListing throws ConnectorGatingError(connection_not_active) and never calls enforcePacing/withSession when the connection status is not active', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'not_active' });
      const gated = buildConnector('swappa', swappaConnector);

      const err = await gated
        .createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConnectorGatingError);
      expect((err as ConnectorGatingError).kind).toBe('connection_not_active');
      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('createListing throws ConnectorGatingError(connection_not_active) and never calls enforcePacing/withSession when the connection is not found', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'not_found' });
      const gated = buildConnector('swappa', swappaConnector);

      await expect(
        gated.createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID)),
      ).rejects.toMatchObject({ kind: 'connection_not_active' });
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('updateListing/markSold/delist all reject with ConnectorGatingError and never call enforcePacing/withSession while the gate is closed', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'not_active' });
      const gated = buildConnector('swappa', swappaConnector);

      await expect(
        gated.updateListing(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID, { title: 'x' }),
      ).rejects.toBeInstanceOf(ConnectorGatingError);
      await expect(gated.markSold(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorGatingError,
      );
      await expect(gated.delist(EXTERNAL_LISTING_ID, DEFAULT_TENANT_ID, CONNECTION_ID)).rejects.toBeInstanceOf(
        ConnectorGatingError,
      );

      expect(mockEnforcePacing).not.toHaveBeenCalled();
      expect(mockWithSession).not.toHaveBeenCalled();
    });

    it('createListing proceeds to enforcePacing/withSession and records the listing once the gate allows it', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: true });
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });
      const gated = buildConnector('swappa', swappaConnector);

      const result = await gated.createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));

      expect(result).toEqual({ externalListingId: EXTERNAL_LISTING_ID });
      expect(mockEnforcePacing).toHaveBeenCalledWith('swappa', CONNECTION_ID);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
      expect(mockRecordListingCreated).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        ITEM_ID,
        'swappa',
        EXTERNAL_LISTING_ID,
      );
    });

    it('checkConnectionHealth bypasses the gate entirely -- a read-only probe, not a marketplace mutation', async () => {
      mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'not_active' });
      mockValidateSessionReadOnly.mockResolvedValue({ healthy: true });
      const gated = buildConnector('swappa', swappaConnector);

      const result = await gated.checkConnectionHealth(DEFAULT_TENANT_ID, CONNECTION_ID);

      expect(result).toEqual({ healthy: true });
      expect(mockAssertCanAutomate).not.toHaveBeenCalled();
      expect(mockValidateSessionReadOnly).toHaveBeenCalledTimes(1);
    });
  });

  describe('dry-run behavior -- a placeholder/no-real-credential connection never launches a real browser', () => {
    it('createListing surfaces withSession\'s dry-run placeholder result as-is, without inspecting or bypassing it (delegation proof, mocked withSession)', async () => {
      const dryRunResult = { dryRun: true, platform: 'swappa', connectionId: CONNECTION_ID };
      mockWithSession.mockResolvedValueOnce(dryRunResult);

      const result = await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));

      expect(result).toBe(dryRunResult);
      expect(mockWithSession).toHaveBeenCalledTimes(1);
    });

    it('createListing/updateListing/markSold/delist each call the mocked withSession exactly once, never driving Playwright directly', async () => {
      mockWithSession.mockResolvedValueOnce({ externalListingId: EXTERNAL_LISTING_ID });
      await createListing(buildElectronicsListingInput(CONNECTION_ID, ITEM_ID));
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

    // The two tests below drive the REAL playwrightSession.ts#withSession
    // (via vi.importActual, bypassing this file's mocked withSession) for a
    // connection whose stored credential is the reserved dry-run marker --
    // i.e. a "placeholder" credential, exactly the credential_status this
    // task calls out. This is the only place in this file that proves the
    // dry-run short-circuit itself (construct + log the intended action,
    // never import `playwright`) for platform=swappa specifically; every
    // other describe block in this file mocks withSession wholesale and can
    // only prove delegation to it (see the two tests directly above).
    it('withSession(real) resolves a dry-run placeholder and logs the intended action for a placeholder/no-real credential, without ever launching a browser or calling the action', async () => {
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
      const action = vi.fn().mockResolvedValue('should-not-run');

      const result = await realWithSession(DEFAULT_TENANT_ID, CONNECTION_ID, action);

      expect(result).toMatchObject({ dryRun: true, platform: 'swappa', connectionId: CONNECTION_ID });
      expect(action).not.toHaveBeenCalled();
      expect(rotateCredential).not.toHaveBeenCalled();
      // Exact match, not stringContaining -- dryRunLog is called here
      // without an itemId, so the ` item=...` suffix must be entirely
      // absent, and the log line must never contain any credential value.
      expect(logSpy).toHaveBeenCalledWith('[dry-run] platform=swappa action=withSession');

      logSpy.mockRestore();
    });

    it('withSession(real) treats an absent credential the same as the placeholder marker -- still dry-run, still no browser', async () => {
      vi.mocked(getConnection).mockReturnValue({
        id: CONNECTION_ID,
        platform: 'swappa',
        status: 'active',
        lastVerifiedAt: null,
        createdAt: '',
        updatedAt: '',
      });
      vi.mocked(getDecryptedCredential).mockReturnValue(null);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const action = vi.fn();

      const result = await realWithSession(DEFAULT_TENANT_ID, CONNECTION_ID, action);

      expect(result).toMatchObject({ dryRun: true, platform: 'swappa' });
      expect(action).not.toHaveBeenCalled();

      logSpy.mockRestore();
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

  describe('suspension classification', () => {
    it('classifySwappaSuspension matches known Swappa suspension/ban/under-review banner text', () => {
      expect(classifySwappaSuspension('Your account has been banned.')).not.toBeNull();
      expect(classifySwappaSuspension('Sorry, your account is temporarily suspended.')).not.toBeNull();
      expect(classifySwappaSuspension('This account is under review.')).not.toBeNull();
    });

    it('classifySwappaSuspension returns null for ambiguous/generic content', () => {
      expect(classifySwappaSuspension('')).toBeNull();
      expect(classifySwappaSuspension('<html><body>Welcome back!</body></html>')).toBeNull();
      expect(classifySwappaSuspension('Navigation timeout of 30000ms exceeded')).toBeNull();
    });

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

  describe('credential scrubbing', () => {
    const FAKE_CREDENTIAL = 'super-secret-swappa-password';

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
