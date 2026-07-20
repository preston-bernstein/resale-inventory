// Single source of truth for values that would otherwise drift across files.
// The SQL CHECK constraint in data/migrations/001_init.sql encodes the same
// condition vocabulary but cannot import this file — changing it requires
// the table-rebuild migration protocol (resale-inventory-change-control §4).

import { UnsupportedCategoryError } from '@/lib/connectors/types';

export const BOOK_CONDITIONS = ['Poor', 'Acceptable', 'Good', 'Very Good', 'Like New'] as const;
export type BookCondition = (typeof BOOK_CONDITIONS)[number];

export const CLOTHING_CONDITIONS = ['NWT', 'NWOT', 'EUC', 'GUC', 'Fair'] as const;
export type ClothingCondition = (typeof CLOTHING_CONDITIONS)[number];

// Refurbished-laptop grading vocabulary (docs/electronics-category-swappa).
export const ELECTRONICS_CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'For Parts'] as const;
export type ElectronicsCondition = (typeof ELECTRONICS_CONDITIONS)[number];

export const CATEGORIES = ['book', 'clothing', 'electronics'] as const;
export type Category = (typeof CATEGORIES)[number];

export function conditionsForCategory(category: Category): readonly string[] {
  switch (category) {
    case 'book':
      return BOOK_CONDITIONS;
    case 'clothing':
      return CLOTHING_CONDITIONS;
    case 'electronics':
      return ELECTRONICS_CONDITIONS;
    default:
      const _exhaustive: never = category;
      throw new Error(`Unknown category: ${_exhaustive}`);
  }
}

// Small hardcoded closed set -- laptop brands, unlike clothing brands, don't
// need a full seeded-vocabulary table.
export const LAPTOP_BRANDS = [
  'Apple',
  'Dell',
  'HP',
  'Lenovo',
  'Asus',
  'Acer',
  'Microsoft',
  'Samsung',
] as const;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Multi-tenant foundation (docs/reseller-multi-tenant-foundation). The
// default tenant id below must match the seeded row in
// data/migrations/005_tenants.sql exactly -- it's how pre-existing
// (pre-multi-tenant) inventory rows are attributed after migration (FR7).
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000000';

export const SESSION_COOKIE_NAME = 'reseller_session';

// App-layer allowlist for platform_connections.platform -- not a DB CHECK
// enum (see data/migrations/007_platform_connections.sql), so this is the
// only thing preventing garbage platform strings from reaching that table.
export const SUPPORTED_PLATFORMS = [
  'ebay',
  'etsy',
  'amazon',
  'poshmark',
  'depop',
  'mercari',
  'vinted',
  'grailed',
  'swappa',
] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

// One source of truth for which platforms support which categories --
// consumed by platformsForCategory() (client picker), assertCategorySupported()
// (every connector's createListing first statement), and the server-side
// platform validation in PATCH /api/items/[id].
const PLATFORM_CATEGORY_SUPPORT: Record<SupportedPlatform, readonly Category[]> = {
  ebay: ['book', 'clothing', 'electronics'],
  etsy: ['book', 'clothing'],
  amazon: ['book', 'clothing', 'electronics'],
  poshmark: ['book', 'clothing', 'electronics'],
  depop: ['book', 'clothing'],
  mercari: ['book', 'clothing', 'electronics'],
  vinted: ['book', 'clothing'],
  grailed: ['book', 'clothing', 'electronics'],
  swappa: ['electronics'],
};

export function platformsForCategory(category: Category): readonly SupportedPlatform[] {
  return SUPPORTED_PLATFORMS.filter((platform) =>
    PLATFORM_CATEGORY_SUPPORT[platform].includes(category)
  );
}

export function assertCategorySupported(platform: SupportedPlatform, category: Category): void {
  if (!PLATFORM_CATEGORY_SUPPORT[platform].includes(category)) {
    throw new UnsupportedCategoryError(platform, category);
  }
}

// Poshmark ban-risk mitigation thresholds (docs/marketplace-connector-tier) --
// grounded in Poshmark's documented May-2025 policy (60-day delist/relist
// cooldown) and share-rate cap (~4000/day "share jail", 3500 is a conservative margin).
export const POSHMARK_RELIST_COOLDOWN_DAYS = 60;
export const POSHMARK_SHARE_CAP_PER_24H = 3500;

// Depop/Mercari/Vinted/Grailed have no published rate-limit policy -- these
// are conservative defaults (1 action per 10s), not documented thresholds
// like Poshmark's above. Each is a separate named constant so any one can be
// tightened/loosened independently without a code search.
export const DEPOP_ACTION_RATE_LIMIT_MS = 10_000;
export const MERCARI_ACTION_RATE_LIMIT_MS = 10_000;
export const VINTED_ACTION_RATE_LIMIT_MS = 10_000;
export const GRAILED_ACTION_RATE_LIMIT_MS = 10_000;
export const SWAPPA_ACTION_RATE_LIMIT_MS = 10_000;
