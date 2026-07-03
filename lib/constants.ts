// Single source of truth for values that would otherwise drift across files.
// The SQL CHECK constraint in data/migrations/001_init.sql encodes the same
// condition vocabulary but cannot import this file — changing it requires
// the table-rebuild migration protocol (book-seller-change-control §4).

export const CONDITIONS = ['Poor', 'Acceptable', 'Good', 'Very Good', 'Like New'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
