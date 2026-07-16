import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { BookCondition } from '@/lib/constants';
import type { Connector, ListingInput } from '@/lib/connectors/types';
import { ConnectorGatingError } from '@/lib/connectors/types';

// lib/automationGate.ts and lib/connectors/itemPlatformsWrite.ts both hit
// the real DB (better-sqlite3) -- mock both so this suite exercises only
// lib/connectors/gate.ts's wrapping/mapping logic against a hand-written
// fake raw connector, never a real platform connector (none exist yet) or
// the real DB.
vi.mock('@/lib/automationGate', () => ({
  assertCanAutomate: vi.fn(),
}));
vi.mock('@/lib/connectors/itemPlatformsWrite', () => ({
  recordListingCreated: vi.fn(),
}));

import { assertCanAutomate } from '@/lib/automationGate';
import { recordListingCreated } from '@/lib/connectors/itemPlatformsWrite';
import { buildConnector } from '@/lib/connectors/gate';

// assertCanAutomate's real return type (lib/automationGate.ts) only knows
// about 'not_found' | 'not_active' | 'consent_required' -- gate.ts's job is
// to map those onto ConnectorGatingError's two kinds. Casting through
// `unknown` (never `any` -- forbidden by this repo's eslint config) lets
// this suite drive the mock with whichever reason string a given test
// wants without fighting that real, narrower type.
const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;
const mockRecordListingCreated = recordListingCreated as unknown as Mock;

function makeFakeRaw(): Connector {
  return {
    createListing: vi.fn().mockResolvedValue({ externalListingId: 'ext-123' }),
    updateListing: vi.fn().mockResolvedValue({ ok: true }),
    markSold: vi.fn().mockResolvedValue({ ok: true }),
    delist: vi.fn().mockResolvedValue({ ok: true }),
    checkConnectionHealth: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

const listingInput: ListingInput = {
  itemId: 'item-1',
  tenantId: 'tenant-1',
  connectionId: 'conn-1',
  title: 'Test Book',
  priceCents: 1000,
  category: 'book',
  details: {
    isbn: '9780000000000',
    author: 'Test Author',
    publisher: null,
    condition: 'Good' as BookCondition,
  },
  photos: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildConnector gating', () => {
  it('throws ConnectorGatingError(missing_consent) and never calls raw.updateListing when consent is missing', async () => {
    mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'consent_required' });
    const fakeRaw = makeFakeRaw();
    const connector = buildConnector('ebay', fakeRaw);

    let caught: unknown;
    try {
      await connector.updateListing('ext-1', 'tenant-1', 'conn-1', { title: 'New Title' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorGatingError);
    expect((caught as ConnectorGatingError).kind).toBe('missing_consent');
    expect(fakeRaw.updateListing).not.toHaveBeenCalled();
  });

  it('throws ConnectorGatingError(connection_not_active) and never calls raw.updateListing when the connection is not active', async () => {
    mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'connection_not_active' });
    const fakeRaw = makeFakeRaw();
    const connector = buildConnector('ebay', fakeRaw);

    let caught: unknown;
    try {
      await connector.updateListing('ext-1', 'tenant-1', 'conn-1', { title: 'New Title' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorGatingError);
    expect((caught as ConnectorGatingError).kind).toBe('connection_not_active');
    expect(fakeRaw.updateListing).not.toHaveBeenCalled();
  });

  it('calls raw.createListing and records the listing when the gate allows it', async () => {
    mockAssertCanAutomate.mockReturnValue({ ok: true });
    const fakeRaw = makeFakeRaw();
    const connector = buildConnector('ebay', fakeRaw);

    const result = await connector.createListing(listingInput);

    expect(result).toEqual({ externalListingId: 'ext-123' });
    expect(fakeRaw.createListing).toHaveBeenCalledWith(listingInput);
    expect(mockRecordListingCreated).toHaveBeenCalledWith('tenant-1', 'item-1', 'ebay', 'ext-123');
  });

  it('checkConnectionHealth calls the raw method directly, without ever consulting the gate', async () => {
    mockAssertCanAutomate.mockReturnValue({ ok: true });
    const fakeRaw = makeFakeRaw();
    const connector = buildConnector('ebay', fakeRaw);

    mockAssertCanAutomate.mockClear();

    const result = await connector.checkConnectionHealth('tenant-1', 'conn-1');

    expect(result).toEqual({ healthy: true });
    expect(fakeRaw.checkConnectionHealth).toHaveBeenCalledWith('tenant-1', 'conn-1');
    expect(mockAssertCanAutomate).not.toHaveBeenCalled();
  });

  it('re-checks the gate fresh on every call: first call succeeds, second call throws once the gate flips', async () => {
    mockAssertCanAutomate
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, reason: 'connection_not_active' });

    const fakeRaw = makeFakeRaw();
    const connector = buildConnector('ebay', fakeRaw);

    const firstResult = await connector.updateListing('ext-1', 'tenant-1', 'conn-1', {
      title: 'New Title',
    });
    expect(firstResult).toEqual({ ok: true });

    let caught: unknown;
    try {
      await connector.updateListing('ext-1', 'tenant-1', 'conn-1', { title: 'Another Title' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorGatingError);
    expect((caught as ConnectorGatingError).kind).toBe('connection_not_active');
    expect(fakeRaw.updateListing).toHaveBeenCalledTimes(1);
    expect(mockAssertCanAutomate).toHaveBeenCalledTimes(2);
  });
});
