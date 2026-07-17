import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

/**
 * Shared resolve-or-create factory for the seeded closed-vocabulary tables
 * (clothing_colors, clothing_materials, clothing_departments — migration
 * 012). Each table is structurally identical: id/tenant_id/canonical_name/
 * created_at with UNIQUE(tenant_id, canonical_name COLLATE NOCASE).
 *
 * Mirrors lib/brands.ts's resolveCanonicalBrand contract (trim, case-
 * insensitive lookup, insert-or-return-winner on race) but is written fresh
 * here rather than by importing/refactoring lib/brands.ts, per requirement
 * 14 — clothing_brands is a separate, untouched table shipped in PR #12.
 *
 * tableName is only ever called with one of three hardcoded literal
 * strings from this codebase's own source (lib/colors.ts, lib/materials.ts,
 * lib/departments.ts) — never user input — so interpolating it into the
 * SQL string (table names cannot be `?`-parameterized) is safe here.
 */
export function createVocabResolver(tableName: string) {
  function selectCanonical(tenantId: string, trimmedValue: string): string | null {
    const row = db
      .prepare(
        `SELECT canonical_name FROM ${tableName}
         WHERE tenant_id = ? AND canonical_name = ? COLLATE NOCASE`,
      )
      .get(tenantId, trimmedValue) as { canonical_name: string } | undefined;
    return row ? row.canonical_name : null;
  }

  function resolveCanonical(tenantId: string, rawValue: string): string {
    const trimmed = rawValue.trim();
    const existing = selectCanonical(tenantId, trimmed);
    if (existing) {
      return existing;
    }
    try {
      db.prepare(
        `INSERT INTO ${tableName} (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
      ).run(uuidv4(), tenantId, trimmed);
      return trimmed;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const winner = selectCanonical(tenantId, trimmed);
        if (winner) {
          return winner;
        }
      }
      throw err;
    }
  }

  // Unlike validateBrandInput's required-non-empty contract, color/material/
  // department are optional fields: undefined or '' are valid (no resolve
  // call made by callers in that case). A non-empty string is valid only if
  // its trimmed length is between 1 and 255 inclusive.
  function validateInput(value: unknown): boolean {
    if (value === undefined || value === '') {
      return true;
    }
    if (typeof value !== 'string') {
      return false;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 255;
  }

  return { resolveCanonical, validateInput, selectCanonical };
}
