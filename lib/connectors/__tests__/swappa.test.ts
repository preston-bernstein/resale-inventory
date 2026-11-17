import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  CONNECTION_ID,
  EXTERNAL_LISTING_ID,
  ITEM_ID,
  beforeAllSwappa,
  beforeEachSwappa,
  buildBookListingInput,
  buildClothingListingInput,
  buildElectronicsListingInput,
  mockAssertCanAutomate,
  mockEnforcePacing,
  mockRecordListingCreated,
  mockValidateSessionReadOnly,
  mockWithSession,
  realWithSession,
} from './swappa.fixtures';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import {
  ConnectorRateLimitedError,
  ConnectorGatingError,
  UnsupportedCategoryError,
} from '@/lib/connectors/types';
import { DRY_RUN_CREDENTIAL_MARKER } from '@/lib/connectors/playwrightSession';
import { getDecryptedCredential, getConnection, rotateCredential } from '@/lib/connections';
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

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('pacing gate -- checked before any Playwright action', () => {
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
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('gating (lib/connectors/gate.ts#buildConnector wrap) -- no network call when consent is invalid or status is not "active"', () => {
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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('gating (lib/connectors/gate.ts#buildConnector wrap) -- no network call when consent is invalid or status is not "active"', () => {
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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('dry-run behavior -- a placeholder/no-real-credential connection never launches a real browser', () => {
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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('dry-run behavior -- a placeholder/no-real-credential connection never launches a real browser', () => {
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
  });
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

  describe('dry-run behavior -- a placeholder/no-real-credential connection never launches a real browser', () => {
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
});

describe('swappa connector', () => {
  beforeAll(beforeAllSwappa);
  beforeEach(beforeEachSwappa);

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
  });
});
