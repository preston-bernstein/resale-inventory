import { vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '../apiFetch';
import { recordSuspensionSignal } from '@/lib/connections';
import type { ListingInput } from '../types';

// amazon.ts's transport dependency is apiFetch and its suspension-signal
// dependency is lib/connections.ts's recordSuspensionSignal -- both mocked
// at the module boundary so this file tests only amazon.ts's own
// gating/request-shaping/error-mapping/suspension-classification logic, not
// apiFetch.ts's retry/timeout behavior (apiFetch.test.ts) or
// lib/connections.ts's DB-backed transition logic (tests/api/kill-switch.test.ts).
vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/connections', () => ({
  recordSuspensionSignal: vi.fn(),
}));

export const DEFAULT_MARKETPLACE_ID = 'ATVPDKIKX0DER';

export const CLIENT_ID_VAR = 'AMAZON_LWA_CLIENT_ID';

export const CLIENT_SECRET_VAR = 'AMAZON_LWA_CLIENT_SECRET';

export const REFRESH_TOKEN_VAR = 'AMAZON_SP_API_REFRESH_TOKEN';

export const AMAZON_ENV_VARS = [CLIENT_ID_VAR, CLIENT_SECRET_VAR, REFRESH_TOKEN_VAR] as const;

export const TEST_CLIENT_ID = 'amzn1.application-oa2-client.test-client-id';

export const TEST_CLIENT_SECRET = 'test-client-secret-value';

export const TEST_REFRESH_TOKEN = 'Atzr|test-refresh-token-value';

export const TEST_ACCESS_TOKEN = 'Atza|test-access-token-value';

export function buildListingInput(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    itemId: 'item-123',
    tenantId: 'tenant-abc',
    connectionId: 'connection-xyz',
    title: 'The Great Gatsby',
    priceCents: 1299,
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

export function buildElectronicsListingInput(): ListingInput {
  return {
    itemId: 'item-elec-456',
    tenantId: 'tenant-abc',
    connectionId: 'connection-xyz',
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

export function mockSuccessfulLwaExchange() {
  vi.mocked(apiFetch).mockResolvedValueOnce({
    status: 200,
    ok: true,
    body: {
      access_token: TEST_ACCESS_TOKEN,
      refresh_token: TEST_REFRESH_TOKEN,
      token_type: 'bearer',
      expires_in: 3600,
    },
  });
}

export const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of AMAZON_ENV_VARS) {
    originalEnv[v] = process.env[v];
  }
  vi.mocked(apiFetch).mockReset();
  vi.mocked(recordSuspensionSignal).mockReset();
});

afterEach(() => {
  for (const v of AMAZON_ENV_VARS) {
    if (originalEnv[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = originalEnv[v];
    }
  }
});

// ---------------------------------------------------------------------------
// Inert by default: all 5 methods must throw AmazonNotConfiguredError before
// ever attempting an HTTP call, when any/all of the 3 required env vars are
// unset.
// ---------------------------------------------------------------------------

export const beforeEachAmazonInertNot = () => {
  for (const v of AMAZON_ENV_VARS) {
    delete process.env[v];
  }
};

// Full body equality -- a mutant that guts productType, drops a
// required attribute, or corrupts the price/description shape would
// slip past a toMatchObject() partial check but not this.
export function expectedBookCreateBody(input: ListingInput) {
  return {
    productType: 'BOOKS',
    requirements: 'LISTING',
    attributes: {
      item_name: [{ value: input.title, marketplace_id: DEFAULT_MARKETPLACE_ID }],
      product_description: [
        {
          value: 'By F. Scott Fitzgerald\nPublisher: Scribner\nISBN: 9780743273565\nCondition: Good',
          marketplace_id: DEFAULT_MARKETPLACE_ID,
        },
      ],
      condition_type: [{ value: 'used_good', marketplace_id: DEFAULT_MARKETPLACE_ID }],
      purchasable_offer: [
        {
          marketplace_id: DEFAULT_MARKETPLACE_ID,
          currency: 'USD',
          our_price: [{ schedule: [{ value_with_tax: input.priceCents / 100 }] }],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Wired, not just guarded: with all 3 env vars set, exercise the real
// request-building / error-mapping / suspension-classification logic against
// mocked HTTP responses. No live SP-API calls anywhere in this file.
// ---------------------------------------------------------------------------

export const beforeEachAmazonConfigured = () => {
  process.env[CLIENT_ID_VAR] = TEST_CLIENT_ID;
  process.env[CLIENT_SECRET_VAR] = TEST_CLIENT_SECRET;
  process.env[REFRESH_TOKEN_VAR] = TEST_REFRESH_TOKEN;
};
