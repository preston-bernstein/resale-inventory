import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

type SeedCategory = 'book' | 'clothing' | 'electronics';

interface SeedKind {
  detailsTable: string;
  // Defaults for the category's own columns. `label` ('Test' or 'Seed') only
  // flavors the free-text values, so a test file can tell its rows apart.
  detailDefaults: (label: string) => Record<string, unknown>;
  itemDefaults: { title: (label: string) => string; acquisition_cost: number };
}

const NO_MEASUREMENTS = {
  color: null,
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
};

const SEED_KINDS: Record<SeedCategory, SeedKind> = {
  book: {
    detailsTable: 'book_details',
    itemDefaults: { title: (label) => `${label} Book`, acquisition_cost: 1000 },
    detailDefaults: (label) => ({
      isbn: null,
      author: `${label} Author`,
      publisher: `${label} Publisher`,
      condition: 'Good',
    }),
  },
  clothing: {
    detailsTable: 'clothing_details',
    itemDefaults: { title: (label) => `${label} Clothing Item`, acquisition_cost: 2000 },
    detailDefaults: (label) => ({
      brand: `${label}Brand`,
      size_label: 'M',
      ...NO_MEASUREMENTS,
      condition: 'EUC',
    }),
  },
  electronics: {
    detailsTable: 'electronics_details',
    itemDefaults: { title: (label) => `${label} Laptop`, acquisition_cost: 45000 },
    detailDefaults: () => ({
      device_type: 'laptop',
      brand: 'Apple',
      model: 'MacBook Pro',
      processor: null,
      ram_gb: null,
      storage_gb: null,
      screen_size_in: null,
      battery_health_pct: null,
      battery_cycle_count: null,
      condition: 'Excellent',
    }),
  },
};

function insertSeedItem(
  category: SeedCategory,
  tenantId: string,
  label: string,
  overrides: Record<string, unknown>,
): string {
  const kind = SEED_KINDS[category];
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    title: kind.itemDefaults.title(label),
    acquisition_cost: kind.itemDefaults.acquisition_cost,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    ...kind.detailDefaults(label),
  };
  const item = { ...defaults, ...overrides, id, category, tenant_id: tenantId };

  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);

  const detailColumns = Object.keys(kind.detailDefaults(label));
  db.prepare(`
    INSERT INTO ${kind.detailsTable} (item_id, ${detailColumns.join(', ')}, tenant_id)
    VALUES (@id, ${detailColumns.map((column) => `@${column}`).join(', ')}, @tenant_id)
  `).run(item);
  return id;
}

/**
 * Item seeders for route tests: each inserts an `items` row plus its
 * category's details row straight through SQL and returns the new id. The
 * tenant is read per call, so a test file can swap tenants between tests.
 */
export function createItemSeeder(getTenantId: () => string, label: 'Test' | 'Seed' = 'Test') {
  return {
    insertBookItem: (overrides: Record<string, unknown> = {}) =>
      insertSeedItem('book', getTenantId(), label, overrides),
    insertClothingItem: (overrides: Record<string, unknown> = {}) =>
      insertSeedItem('clothing', getTenantId(), label, overrides),
    insertElectronicsItem: (overrides: Record<string, unknown> = {}) =>
      insertSeedItem('electronics', getTenantId(), label, overrides),
  };
}
