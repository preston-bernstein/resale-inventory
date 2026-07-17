import { describe, it, expect, beforeEach, vi } from 'vitest';
import db from '@/lib/db';
import { createVocabResolver } from '@/lib/vocabResolver';
import { resolveCanonicalColor, validateColorInput, selectCanonicalColor } from '@/lib/colors';
import {
  resolveCanonicalMaterial,
  validateMaterialInput,
  selectCanonicalMaterial,
} from '@/lib/materials';
import {
  resolveCanonicalDepartment,
  validateDepartmentInput,
  selectCanonicalDepartment,
} from '@/lib/departments';
import { createTestTenant } from '../../tests/helpers/tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentTenant: ReturnType<typeof createTestTenant>;

beforeEach(() => {
  currentTenant = createTestTenant();
});

function rowsForName(tableName: string, tenantId: string, canonicalName: string) {
  return db
    .prepare(
      `SELECT id, canonical_name FROM ${tableName}
       WHERE tenant_id = ? AND canonical_name = ? COLLATE NOCASE`,
    )
    .all(tenantId, canonicalName) as Array<{ id: string; canonical_name: string }>;
}

// ---------------------------------------------------------------------------
// createVocabResolver factory + all three instantiations
// ---------------------------------------------------------------------------

describe.each([
  {
    label: 'color',
    tableName: 'clothing_colors',
    resolve: resolveCanonicalColor,
    validate: validateColorInput,
    select: selectCanonicalColor,
    seededValue: 'Gray',
    seededLower: 'gray',
    newValue: 'Chartreuse',
  },
  {
    label: 'material',
    tableName: 'clothing_materials',
    resolve: resolveCanonicalMaterial,
    validate: validateMaterialInput,
    select: selectCanonicalMaterial,
    seededValue: 'Cotton',
    seededLower: 'cotton',
    newValue: 'Kevlar',
  },
  {
    label: 'department',
    tableName: 'clothing_departments',
    resolve: resolveCanonicalDepartment,
    validate: validateDepartmentInput,
    select: selectCanonicalDepartment,
    seededValue: "Men's",
    seededLower: "men's",
    newValue: 'Nonbinary',
  },
])(
  'createVocabResolver instantiation: $label ($tableName)',
  ({ tableName, resolve, validate, select, seededValue, seededLower, newValue }) => {
    describe('resolveCanonical', () => {
      it('matches an existing seeded value case-insensitively, returning the stored canonical casing', () => {
        const resolved = resolve(currentTenant.tenantId, seededLower);
        expect(resolved).toBe(seededValue);
        // No duplicate row should have been created for the seeded value.
        expect(rowsForName(tableName, currentTenant.tenantId, seededValue)).toHaveLength(1);
      });

      it('exact-case match on a seeded value returns it unchanged', () => {
        const resolved = resolve(currentTenant.tenantId, seededValue);
        expect(resolved).toBe(seededValue);
      });

      it('an unseeded value creates a new canonical row and returns the trimmed value', () => {
        expect(rowsForName(tableName, currentTenant.tenantId, newValue)).toHaveLength(0);
        const resolved = resolve(currentTenant.tenantId, newValue);
        expect(resolved).toBe(newValue);
        const rows = rowsForName(tableName, currentTenant.tenantId, newValue);
        expect(rows).toHaveLength(1);
        expect(rows[0].canonical_name).toBe(newValue);
      });

      it('trims whitespace before matching an existing value', () => {
        const resolved = resolve(currentTenant.tenantId, `  ${seededLower}  `);
        expect(resolved).toBe(seededValue);
        expect(rowsForName(tableName, currentTenant.tenantId, seededValue)).toHaveLength(1);
      });

      it('trims whitespace before storing a new value', () => {
        const resolved = resolve(currentTenant.tenantId, `  ${newValue}  `);
        expect(resolved).toBe(newValue);
        const rows = rowsForName(tableName, currentTenant.tenantId, newValue);
        expect(rows).toHaveLength(1);
        expect(rows[0].canonical_name).toBe(newValue);
      });

      it('concurrent resolution of the same new value races safely to exactly one row', async () => {
        const results = await Promise.all([
          Promise.resolve().then(() => resolve(currentTenant.tenantId, newValue)),
          Promise.resolve().then(() => resolve(currentTenant.tenantId, newValue)),
          Promise.resolve().then(() => resolve(currentTenant.tenantId, newValue.toLowerCase())),
          Promise.resolve().then(() => resolve(currentTenant.tenantId, newValue.toUpperCase())),
        ]);

        // All concurrent callers must agree on the same canonical string.
        expect(new Set(results).size).toBe(1);
        expect(results[0]).toBe(newValue);

        // Only one row should exist despite four concurrent callers all
        // missing the initial SELECT at roughly the same time.
        const rows = rowsForName(tableName, currentTenant.tenantId, newValue);
        expect(rows).toHaveLength(1);
      });
    });

    describe('validateInput', () => {
      it('accepts undefined', () => {
        expect(validate(undefined)).toBe(true);
      });

      it('accepts an empty string', () => {
        expect(validate('')).toBe(true);
      });

      it('accepts a valid non-empty string', () => {
        expect(validate('Some Valid Value')).toBe(true);
      });

      it('rejects a string longer than 255 characters', () => {
        const tooLong = 'a'.repeat(256);
        expect(validate(tooLong)).toBe(false);
      });

      it('accepts a string exactly 255 characters long', () => {
        const maxLength = 'a'.repeat(255);
        expect(validate(maxLength)).toBe(true);
      });

      it('rejects a non-string value (number)', () => {
        expect(validate(42)).toBe(false);
      });

      it('rejects a whitespace-only string', () => {
        expect(validate('    ')).toBe(false);
      });
    });

    describe('selectCanonical', () => {
      it('returns null for a value that does not exist for this tenant', () => {
        expect(select(currentTenant.tenantId, 'Definitely Not Seeded Or Created')).toBeNull();
      });

      it('returns the canonical name once the value has been resolved', () => {
        resolve(currentTenant.tenantId, newValue);
        expect(select(currentTenant.tenantId, newValue)).toBe(newValue);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Direct SQLITE_CONSTRAINT_UNIQUE recovery path
//
// better-sqlite3 is synchronous, so the Promise.all-based "concurrent race"
// tests above never actually interleave two callers mid-insert -- the first
// Promise callback runs to completion (select miss, insert, return) before
// the next one's select ever executes, so it always already finds the row.
// That means resolveCanonical's catch block (the real UNIQUE-violation
// recovery path) is only exercised here, by forcing db.prepare's INSERT
// statement to throw the exact error shape better-sqlite3 raises for a
// genuine UNIQUE constraint violation, while still performing the insert a
// concurrent writer would have committed first.
// ---------------------------------------------------------------------------

describe('resolveCanonical: real SQLITE_CONSTRAINT_UNIQUE recovery', () => {
  it('falls back to the winning row when the insert itself throws a UNIQUE violation', () => {
    const value = 'RaceWinner';
    const insertSql = 'INSERT INTO clothing_colors (id, tenant_id, canonical_name) VALUES (?, ?, ?)';
    const originalPrepare = db.prepare.bind(db);
    let intercepted = false;

    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!intercepted && sql === insertSql) {
        intercepted = true;
        return {
          run: (...args: unknown[]) => {
            // A concurrent writer commits the same row first, using the
            // same statement text and args the resolver itself would have
            // used, so the DB ends up in exactly the state a real race
            // would produce.
            originalPrepare(insertSql).run(...(args as [string, string, string]));
            const err = new Error(
              'UNIQUE constraint failed: clothing_colors.tenant_id, clothing_colors.canonical_name',
            ) as Error & { code: string };
            err.code = 'SQLITE_CONSTRAINT_UNIQUE';
            throw err;
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    try {
      const resolved = resolveCanonicalColor(currentTenant.tenantId, value);
      expect(resolved).toBe(value);
    } finally {
      prepareSpy.mockRestore();
    }

    expect(rowsForName('clothing_colors', currentTenant.tenantId, value)).toHaveLength(1);
  });

  it('rethrows a non-UNIQUE error unchanged', () => {
    const value = 'SomeOtherNewValue';
    const insertSql = 'INSERT INTO clothing_colors (id, tenant_id, canonical_name) VALUES (?, ?, ?)';
    const originalPrepare = db.prepare.bind(db);
    let intercepted = false;

    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!intercepted && sql === insertSql) {
        intercepted = true;
        return {
          run: () => {
            throw new Error('disk I/O error');
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    try {
      expect(() => resolveCanonicalColor(currentTenant.tenantId, value)).toThrow(
        'disk I/O error',
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('rethrows when the UNIQUE-coded error still finds no winner row', () => {
    const value = 'PhantomWinner';
    const insertSql = 'INSERT INTO clothing_colors (id, tenant_id, canonical_name) VALUES (?, ?, ?)';
    const originalPrepare = db.prepare.bind(db);
    let intercepted = false;

    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!intercepted && sql === insertSql) {
        intercepted = true;
        return {
          run: () => {
            // No row actually gets committed anywhere -- an impossible-in-
            // practice but defensively-handled shape: a UNIQUE-coded error
            // whose fallback SELECT still comes up empty.
            const err = new Error('UNIQUE constraint failed') as Error & { code: string };
            err.code = 'SQLITE_CONSTRAINT_UNIQUE';
            throw err;
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    });

    try {
      expect(() => resolveCanonicalColor(currentTenant.tenantId, value)).toThrow(
        'UNIQUE constraint failed',
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Factory-level behavior (independent of the three lib wrappers)
// ---------------------------------------------------------------------------

describe('createVocabResolver factory', () => {
  it('produces independent resolvers scoped to their own table', () => {
    const colorResolver = createVocabResolver('clothing_colors');
    const materialResolver = createVocabResolver('clothing_materials');

    const colorResult = colorResolver.resolveCanonical(currentTenant.tenantId, 'Chartreuse');
    const materialResult = materialResolver.resolveCanonical(currentTenant.tenantId, 'Kevlar');

    expect(colorResult).toBe('Chartreuse');
    expect(materialResult).toBe('Kevlar');

    // A value resolved through one table's resolver must not leak into the
    // other table.
    expect(materialResolver.selectCanonical(currentTenant.tenantId, 'Chartreuse')).toBeNull();
    expect(colorResolver.selectCanonical(currentTenant.tenantId, 'Kevlar')).toBeNull();
  });

  it('scopes resolution to the requesting tenant only', () => {
    const tenantB = createTestTenant();

    resolveCanonicalColor(currentTenant.tenantId, 'Chartreuse');

    expect(selectCanonicalColor(currentTenant.tenantId, 'Chartreuse')).toBe('Chartreuse');
    expect(selectCanonicalColor(tenantB.tenantId, 'Chartreuse')).toBeNull();
  });
});
