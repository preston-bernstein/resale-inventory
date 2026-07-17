import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

/**
 * Validate a raw brand input value per plan.md's API contract: must be a
 * string, non-empty after trimming, and no more than 255 characters.
 *
 * This is a separate concern from resolveCanonicalBrand — callers (the API
 * route) should validate first, then resolve.
 */
export function validateBrandInput(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 255;
}

/**
 * Resolve a raw brand string to its canonical clothing_brands.canonical_name
 * for this tenant, case-insensitively (no alias table — aliases are out of
 * scope for this feature).
 *
 * 1. Trim the input.
 * 2. Look up an existing clothing_brands row for this tenant whose
 *    canonical_name matches case-insensitively (COLLATE NOCASE). If found,
 *    return its canonical_name as-is (preserving whatever casing was
 *    originally stored).
 * 3. Otherwise insert a new clothing_brands row using the trimmed input as
 *    canonical_name, and return it.
 *
 * Concurrency: two requests can race to insert the same new brand at the
 * same time. The UNIQUE(tenant_id, canonical_name COLLATE NOCASE) constraint
 * lets only one INSERT win; the loser catches SQLITE_CONSTRAINT_UNIQUE,
 * re-SELECTs, and returns the winner's canonical_name instead of throwing.
 */
export function resolveCanonicalBrand(tenantId: string, rawBrand: string): string {
  const trimmed = rawBrand.trim();

  const existing = selectCanonicalBrand(tenantId, trimmed);
  if (existing) {
    return existing;
  }

  try {
    db.prepare(
      `INSERT INTO clothing_brands (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
    ).run(uuidv4(), tenantId, trimmed);
    return trimmed;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Another concurrent request won the race and inserted this brand
      // first — reuse its canonical_name rather than erroring out.
      const winner = selectCanonicalBrand(tenantId, trimmed);
      if (winner) {
        return winner;
      }
    }
    throw err;
  }
}

/** Case-insensitive lookup of an existing canonical_name for this tenant. */
function selectCanonicalBrand(tenantId: string, trimmedBrand: string): string | null {
  const row = db
    .prepare(
      `SELECT canonical_name FROM clothing_brands
       WHERE tenant_id = ? AND canonical_name = ? COLLATE NOCASE`,
    )
    .get(tenantId, trimmedBrand) as { canonical_name: string } | undefined;
  return row ? row.canonical_name : null;
}
