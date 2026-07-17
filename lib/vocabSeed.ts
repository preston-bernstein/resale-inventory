import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

// JS-side source of truth for starter vocabulary. Migration 012's SQL
// literals are a frozen snapshot of these same four lists (used to
// one-time-backfill existing tenants) -- keep both in sync if these ever
// change, though in practice these are meant to stay fixed.
export const STARTER_COLORS: readonly string[] = [
  'Black',
  'White',
  'Gray',
  'Navy',
  'Red',
  'Blue',
  'Green',
  'Yellow',
  'Orange',
  'Purple',
  'Pink',
  'Brown',
  'Beige',
  'Multicolor',
];

export const STARTER_MATERIALS: readonly string[] = [
  'Cotton',
  'Polyester',
  'Wool',
  'Denim',
  'Leather',
  'Silk',
  'Linen',
  'Cashmere',
  'Nylon',
  'Spandex',
  'Rayon',
  'Fleece',
  'Suede',
  'Canvas',
];

export const STARTER_DEPARTMENTS: readonly string[] = ["Men's", "Women's", "Kids'", 'Unisex', 'Baby'];

const STARTER_BRANDS: readonly string[] = [
  'Nike',
  'Adidas',
  "Levi's",
  'Zara',
  'H&M',
  'Gap',
  'Old Navy',
  'Ralph Lauren',
  'Tommy Hilfiger',
  'Calvin Klein',
  'Coach',
  'Michael Kors',
  'Patagonia',
  'The North Face',
  'Lululemon',
  'Under Armour',
  'Vans',
  'Converse',
  'New Balance',
  'Champion',
  'Carhartt',
  'J.Crew',
  'Banana Republic',
  'American Eagle',
  'Free People',
];

/**
 * Seed the four starter vocabulary tables (clothing_colors,
 * clothing_materials, clothing_departments, clothing_brands) for a
 * brand-new tenant, mirroring migration 012's one-time backfill of existing
 * tenants at feature-ship time.
 *
 * Uses uuid v4 for every row's id (same approach as lib/brands.ts's
 * resolveCanonicalBrand) -- clothing_brands still carries its UUIDv4-shaped
 * CHECK constraint, and the other three tables have no id-shape CHECK at
 * all, so one id scheme works for all four.
 *
 * Plain INSERT (not INSERT OR IGNORE): this is only ever called for a
 * brand-new tenantId that cannot already have rows in these tables, so a
 * genuine UNIQUE violation here indicates a real bug and should throw
 * rather than be silently swallowed.
 */
export function seedStarterVocabulary(tenantId: string): void {
  const insertColor = db.prepare(
    `INSERT INTO clothing_colors (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
  );
  const insertMaterial = db.prepare(
    `INSERT INTO clothing_materials (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
  );
  const insertDepartment = db.prepare(
    `INSERT INTO clothing_departments (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
  );
  const insertBrand = db.prepare(
    `INSERT INTO clothing_brands (id, tenant_id, canonical_name) VALUES (?, ?, ?)`,
  );

  const seed = db.transaction(() => {
    for (const name of STARTER_COLORS) {
      insertColor.run(uuidv4(), tenantId, name);
    }
    for (const name of STARTER_MATERIALS) {
      insertMaterial.run(uuidv4(), tenantId, name);
    }
    for (const name of STARTER_DEPARTMENTS) {
      insertDepartment.run(uuidv4(), tenantId, name);
    }
    for (const name of STARTER_BRANDS) {
      insertBrand.run(uuidv4(), tenantId, name);
    }
  });

  seed();
}
