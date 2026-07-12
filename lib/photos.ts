import path from 'path';

// Mirrors lib/db.ts's BOOKSELLER_DB_PATH pattern: configurable via
// BOOKSELLER_PHOTOS_PATH so tests can point uploads at a throwaway directory
// instead of the operator's real data/photos/ tree. Unset → the historical
// cwd default, so behavior is unchanged in production.
export const PHOTOS_ROOT = path.resolve(
  process.env.BOOKSELLER_PHOTOS_PATH ?? path.join(process.cwd(), 'data', 'photos'),
);
