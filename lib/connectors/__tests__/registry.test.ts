import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { BookCondition } from '@/lib/constants';
import { SUPPORTED_PLATFORMS } from '@/lib/constants';
import type { Connector, ListingInput } from '@/lib/connectors/types';
import { ConnectorGatingError, UnsupportedPlatformError } from '@/lib/connectors/types';

// lib/automationGate.ts and lib/connectors/itemPlatformsWrite.ts both hit the
// real DB (better-sqlite3) -- mocked here so assertion 4 below can
// deterministically flip the gate to "blocked" and prove getConnector() hands
// back the GATED connector (gate.ts#buildConnector output), not a raw
// unwrapped platform connector, and so the platform-identity assertions
// below can inspect exactly what string each registry entry threads through
// to recordListingCreated. Every other assertion in this file never calls a
// mutating method, so it doesn't strictly need these mocks -- they're set up
// unconditionally (rather than per-test) purely so vi.mock's hoisting
// requirement (must precede the registry import) is satisfied.
vi.mock('@/lib/automationGate', () => ({
  assertCanAutomate: vi.fn(),
}));
vi.mock('@/lib/connectors/itemPlatformsWrite', () => ({
  recordListingCreated: vi.fn(),
}));

// Each real platform connector module (ebay.ts, etsy.ts, ...) does real
// network/browser work in createListing. registry.ts's only job is to wire
// the RIGHT platform-name string literal into buildConnector() for each
// entry (gate.ts#buildConnector threads that string straight into
// recordListingCreated on a successful createListing) -- it's not this
// suite's job to re-verify each platform connector's own business logic
// (that's <platform>.test.ts's job). So every platform connector module is
// replaced with a bare fake exposing the same 5 Connector methods, letting
// the tests below drive createListing() through the real registry + real
// gate.ts wiring and observe exactly which platform string comes out the
// other end.
function fakeConnector(): Connector {
  return {
    createListing: vi.fn().mockResolvedValue({ externalListingId: 'ext-fake' }),
    updateListing: vi.fn().mockResolvedValue({ ok: true }),
    markSold: vi.fn().mockResolvedValue({ ok: true }),
    delist: vi.fn().mockResolvedValue({ ok: true }),
    checkConnectionHealth: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

vi.mock('@/lib/connectors/ebay', () => ({ ebayConnector: fakeConnector() }));
vi.mock('@/lib/connectors/etsy', () => ({ etsyConnector: fakeConnector() }));
vi.mock('@/lib/connectors/amazon', () => ({ amazonConnector: fakeConnector() }));
vi.mock('@/lib/connectors/poshmark', () => ({ poshmarkConnector: fakeConnector() }));
vi.mock('@/lib/connectors/depop', () => ({ depopConnector: fakeConnector() }));
vi.mock('@/lib/connectors/mercari', () => ({ mercariConnector: fakeConnector() }));
vi.mock('@/lib/connectors/vinted', () => ({ vintedConnector: fakeConnector() }));
vi.mock('@/lib/connectors/grailed', () => ({ grailedConnector: fakeConnector() }));

import { assertCanAutomate } from '@/lib/automationGate';
import { recordListingCreated } from '@/lib/connectors/itemPlatformsWrite';
import { getConnector } from '@/lib/connectors/registry';

const mockAssertCanAutomate = assertCanAutomate as unknown as Mock;
const mockRecordListingCreated = recordListingCreated as unknown as Mock;

function makeListingInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertCanAutomate.mockReturnValue({ ok: true });
});

describe('registry#getConnector', () => {
  it('returns an object with all 5 Connector methods for a valid platform', () => {
    const connector = getConnector('ebay');

    expect(typeof connector.createListing).toBe('function');
    expect(typeof connector.updateListing).toBe('function');
    expect(typeof connector.markSold).toBe('function');
    expect(typeof connector.delist).toBe('function');
    expect(typeof connector.checkConnectionHealth).toBe('function');
  });

  it('throws UnsupportedPlatformError for an unknown platform string', () => {
    let caught: unknown;
    try {
      getConnector('invalid_platform_xyz');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnsupportedPlatformError);
    expect((caught as UnsupportedPlatformError).message).toBe(
      'Unsupported platform: invalid_platform_xyz',
    );
  });

  // The guard is `!SUPPORTED_PLATFORMS.includes(platform)`. A mutant that
  // flips `includes` to always return true (or that flips the `!`) would
  // still pass a single garbage-string test if that test only checks "some
  // exception is thrown" -- these boundary cases (empty string, a supported
  // platform name with different casing, a prefix/suffix of a real platform,
  // and a real platform name with trailing whitespace) all must independently
  // resolve to "unsupported" for the guard to be doing real work.
  it.each(['', 'Ebay', 'ebay ', ' ebay', 'ebayy', 'eba', 'EBAY', 'null', 'undefined'])(
    'throws UnsupportedPlatformError for garbage input %j',
    (garbage) => {
      let caught: unknown;
      try {
        getConnector(garbage);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UnsupportedPlatformError);
      expect((caught as UnsupportedPlatformError).message).toBe(`Unsupported platform: ${garbage}`);
    },
  );

  it('returns a connector for every SUPPORTED_PLATFORMS entry -- none missing', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      const connector = getConnector(platform);

      expect(connector).toBeDefined();
      expect(typeof connector.createListing).toBe('function');
      expect(typeof connector.updateListing).toBe('function');
      expect(typeof connector.markSold).toBe('function');
      expect(typeof connector.delist).toBe('function');
      expect(typeof connector.checkConnectionHealth).toBe('function');
    }
  });

  it('returns a GATED connector -- updateListing throws ConnectorGatingError when the automation gate blocks the call', async () => {
    mockAssertCanAutomate.mockReturnValue({ ok: false, reason: 'consent_required' });

    const connector = getConnector('ebay');

    let caught: unknown;
    try {
      await connector.updateListing('ext-1', 'tenant-1', 'conn-1', { title: 'New Title' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectorGatingError);
    expect((caught as ConnectorGatingError).kind).toBe('missing_consent');
  });

  // registry.ts's CONNECTORS map pairs each platform key with its OWN
  // platform-name string literal passed into buildConnector(), e.g.
  // `vinted: buildConnector('vinted', vintedConnector)`. A mutant that
  // swaps that literal for the empty string (or any other platform's name)
  // is invisible to assertions that only check "a function came back" --
  // it only shows up in what gate.ts#buildConnector threads through to
  // recordListingCreated on a successful createListing. Driving createListing
  // through the real registry + real gate.ts wiring for every single
  // platform and asserting the exact platform string recorded is the only
  // way to pin each of the 8 map entries to its own distinct literal.
  it.each(SUPPORTED_PLATFORMS)(
    'wires the %s registry entry to its own platform-name literal, verified via recordListingCreated',
    async (platform) => {
      const connector = getConnector(platform);

      await connector.createListing(makeListingInput());

      expect(mockRecordListingCreated).toHaveBeenCalledWith(
        'tenant-1',
        'item-1',
        platform,
        'ext-fake',
      );
    },
  );
});
