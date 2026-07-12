// Single source of truth for values that would otherwise drift across files.
// The SQL CHECK constraint in data/migrations/001_init.sql encodes the same
// condition vocabulary but cannot import this file — changing it requires
// the table-rebuild migration protocol (resale-inventory-change-control §4).

export const BOOK_CONDITIONS = ['Poor', 'Acceptable', 'Good', 'Very Good', 'Like New'] as const;
export type BookCondition = (typeof BOOK_CONDITIONS)[number];

export const CLOTHING_CONDITIONS = ['NWT', 'NWOT', 'EUC', 'GUC', 'Fair'] as const;
export type ClothingCondition = (typeof CLOTHING_CONDITIONS)[number];

export const CATEGORIES = ['book', 'clothing'] as const;
export type Category = (typeof CATEGORIES)[number];

export function conditionsForCategory(category: Category): readonly string[] {
  switch (category) {
    case 'book':
      return BOOK_CONDITIONS;
    case 'clothing':
      return CLOTHING_CONDITIONS;
    default:
      const _exhaustive: never = category;
      throw new Error(`Unknown category: ${_exhaustive}`);
  }
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
