import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

// Direct-SQL seeders for the items table and its category detail tables.
// Tests that need rows without going through POST /api/items use these,
// so the column lists live in one place.

function insertItemRow(item: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date, tenant_id)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
  `).run(item);
}

/** Seed a book item directly via SQL (items + book_details). Returns the id. */
export function seedBookItem(tenantId: string, overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Seed Author',
    publisher: 'Seed Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book', tenant_id: tenantId };
  insertItemRow(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition, tenant_id)
    VALUES (@id, @isbn, @author, @publisher, @condition, @tenant_id)
  `).run(item);
  return id;
}

/** Seed a clothing item directly via SQL (items + clothing_details). Returns the id. */
export function seedClothingItem(tenantId: string, overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'SeedBrand',
    size_label: 'M',
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
    condition: 'EUC',
  };
  const item = { ...defaults, ...overrides, id, category: 'clothing', tenant_id: tenantId };
  insertItemRow(item);
  db.prepare(`
    INSERT INTO clothing_details
      (item_id, brand, size_label, color, material, gender_department, weight_oz,
       pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
       leg_opening_in, hip_in, condition, tenant_id)
    VALUES
      (@id, @brand, @size_label, @color, @material, @gender_department, @weight_oz,
       @pit_to_pit_in, @length_in, @sleeve_length_in, @waist_in, @rise_in, @inseam_in,
       @leg_opening_in, @hip_in, @condition, @tenant_id)
  `).run(item);
  return id;
}

/** Seed an electronics item directly via SQL (items + electronics_details). Returns the id. */
export function seedElectronicsItem(tenantId: string, overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Laptop',
    acquisition_cost: 45000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
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
  };
  const item = { ...defaults, ...overrides, id, category: 'electronics', tenant_id: tenantId };
  insertItemRow(item);
  db.prepare(`
    INSERT INTO electronics_details
      (item_id, device_type, brand, model, processor, ram_gb, storage_gb,
       screen_size_in, battery_health_pct, battery_cycle_count, condition, tenant_id)
    VALUES
      (@id, @device_type, @brand, @model, @processor, @ram_gb, @storage_gb,
       @screen_size_in, @battery_health_pct, @battery_cycle_count, @condition, @tenant_id)
  `).run(item);
  return id;
}

export function deleteAllItems() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM electronics_details; DELETE FROM items;',
  );
}

