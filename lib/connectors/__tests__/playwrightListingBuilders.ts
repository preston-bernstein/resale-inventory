import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import type { ListingInput } from '@/lib/connectors/types';

// Plain builders for the Playwright-driven connector suites (depop, grailed,
// mercari, poshmark, swappa, vinted). No mocks live here: each suite's mock
// module registers them.

interface ClothingInputFields {
  title: string;
  priceCents: number;
  color: string;
}

export function buildClothingInput(
  connectionId: string,
  itemId: string,
  { title, priceCents, color }: ClothingInputFields,
): ListingInput {
  return {
    itemId,
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    title,
    priceCents,
    category: 'clothing',
    details: {
      brand: 'Acme',
      size_label: 'M',
      color,
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

export function buildBookInput(connectionId: string, itemId: string): ListingInput {
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

export function buildElectronicsInput(connectionId: string, itemId: string): ListingInput {
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

interface FakePageOverrides {
  content?: () => Promise<string>;
  url?: () => string;
  isVisible?: (selector: string) => Promise<boolean>;
}

interface FakePageDefaults {
  url: () => string;
  isVisible: boolean;
}

/** A fake Playwright `Page`: every call is a mock, `defaults` fill what `overrides` leaves out. */
export function makeFakePageWith(defaults: FakePageDefaults, overrides: FakePageOverrides = {}) {
  return {
    goto: vi.fn(),
    fill: vi.fn(),
    check: vi.fn(),
    click: vi.fn(),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    url: overrides.url ?? defaults.url,
    content: overrides.content ?? (async () => ''),
    setInputFiles: vi.fn(),
    isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(defaults.isVisible),
  };
}

/**
 * Wires the mocked withSession to invoke the callback it gets (the real
 * createListingAction/updateListingAction/markSoldAction/delistAction
 * closures) against `page`, instead of only recording the call. That runs the
 * real Playwright-interaction code: navigation, fills, id extraction.
 */
export function wireSessionTo(mockWithSession: Mock, page: unknown): void {
  mockWithSession.mockImplementation(
    async (_tenantId: string, _connectionId: string, action: (p: unknown) => Promise<unknown>) => action(page),
  );
}
