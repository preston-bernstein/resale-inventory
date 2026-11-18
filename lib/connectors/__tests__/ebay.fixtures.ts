import { vi, beforeEach, afterEach } from 'vitest';
import type { ListingInput } from '../types';
import { recordSuspensionSignal } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';
import { apiFetch } from '../apiFetch';

// recordSuspensionSignal is mocked at the '@/lib/connections' boundary --
// same discipline as etsy.test.ts. ebay.ts (unlike etsy.ts) doesn't need
// getDecryptedCredential -- there's no shop_id-equivalent lookup here, the
// offerId returned by createListing carries everything subsequent calls
// need (see ebay.ts's createListing doc comment).
vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

// getFreshAccessToken's own freshness/caching/refresh logic is covered by
// apiCredential.test.ts, and ebayExchangeFn's OAuth request-shaping is
// covered by ebay.oauth.test.ts -- this file mocks getFreshAccessToken
// directly so each test can hand back a known fake token (or simulate a
// config error) without wiring up a real stored-credential/exchange round
// trip.
vi.mock('../apiCredential', () => ({
  getFreshAccessToken: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

export const TENANT_ID = 'tenant-1';

export const CONNECTION_ID = 'conn-1';

export const FAKE_SECRET_TOKEN = 'sekrit-ebay-access-token-xyz789';

export function baseInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    itemId: 'item-1',
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    title: 'The Great Gatsby',
    priceCents: 1999,
    category: 'book',
    details: {
      isbn: '9780743273565',
      author: 'F. Scott Fitzgerald',
      publisher: 'Scribner',
      condition: 'Good',
    },
    photos: [],
    ...overrides,
  };
}

export function buildElectronicsInput(): ListingInput {
  return {
    itemId: 'item-elec-1',
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
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

export const originalEbayEnv = process.env.EBAY_ENV;

beforeEach(() => {
  vi.mocked(recordSuspensionSignal).mockReset();
  vi.mocked(getFreshAccessToken).mockReset();
  vi.mocked(apiFetch).mockReset();

  process.env.EBAY_ENV = 'sandbox';
  vi.mocked(getFreshAccessToken).mockResolvedValue(FAKE_SECRET_TOKEN);
});

afterEach(() => {
  if (originalEbayEnv === undefined) {
    delete process.env.EBAY_ENV;
  } else {
    process.env.EBAY_ENV = originalEbayEnv;
  }
});

/** Run `run` and return what it rejected with, or undefined if it resolved. */
export async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}
