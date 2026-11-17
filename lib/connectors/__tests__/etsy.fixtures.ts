import { vi, beforeEach } from 'vitest';
import type { ListingInput } from '../types';
import { getDecryptedCredential, recordSuspensionSignal } from '@/lib/connections';
import { getFreshAccessToken } from '../apiCredential';
import { apiFetch } from '../apiFetch';

// getDecryptedCredential (used here for shop_id resolution) and
// recordSuspensionSignal are mocked at the '@/lib/connections' boundary --
// same discipline as apiCredential.test.ts mocking the CRUD/encryption
// layer underneath it.
vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  recordSuspensionSignal: vi.fn(),
}));

// getFreshAccessToken's own freshness/caching/refresh logic is covered by
// apiCredential.test.ts -- this connector's tests mock it directly so a
// test can hand back a known fake token without wiring up a real
// stored-credential/exchange round trip.
vi.mock('../apiCredential', () => ({
  getFreshAccessToken: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
  apiFetch: vi.fn(),
}));

export const TENANT_ID = 'tenant-1';

export const CONNECTION_ID = 'conn-1';

export const FAKE_SECRET_TOKEN = 'sekrit-access-token-xyz789';

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

beforeEach(() => {
  vi.mocked(getDecryptedCredential).mockReset();
  vi.mocked(recordSuspensionSignal).mockReset();
  vi.mocked(getFreshAccessToken).mockReset();
  vi.mocked(apiFetch).mockReset();

  process.env.ETSY_API_KEY = 'test-etsy-api-key';
  process.env.ETSY_SHARED_SECRET = 'test-etsy-shared-secret';

  vi.mocked(getDecryptedCredential).mockReturnValue({ shopId: 'shop-123' });
  vi.mocked(getFreshAccessToken).mockResolvedValue(FAKE_SECRET_TOKEN);
});
