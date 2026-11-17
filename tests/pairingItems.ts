import { v4 as uuidv4 } from 'uuid';
import db from '../lib/db';
import { DEFAULT_TENANT_ID } from '../lib/constants';

/**
 * Empties the item tables and everything that points at them. Child tables go
 * first: items may be referenced by satellite tables left over from other
 * test files sharing the same scratch DB, and foreign_keys=ON rejects a
 * blanket DELETE FROM items while any of those rows still point at it.
 */
export function clearItemTables(): void {
  db.exec(
    'DELETE FROM phone_pairing_tokens; DELETE FROM item_photos; ' +
      'DELETE FROM price_history; DELETE FROM item_platforms; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

/**
 * Returns a function that inserts a bare `items` row (no details row) of the
 * given category, as the pairing-token tests need only the FK target. The
 * row lands on the default tenant unless `overrides` says otherwise.
 */
export function createBareItemInserter(category: 'book' | 'clothing') {
  return function insertTestItem(overrides: Record<string, unknown> = {}): string {
    const id = uuidv4();
    const defaults: Record<string, unknown> = {
      id,
      category,
      title: 'Test Item',
      acquisition_cost: 1000,
      acquisition_date: '2024-01-01',
      status: 'Unlisted',
      listing_price: null,
      sale_price: null,
      sale_platform: null,
      sale_date: null,
      tenant_id: DEFAULT_TENANT_ID,
    };
    const item = { ...defaults, ...overrides, id };
    db.prepare(`
      INSERT INTO items
        (id, category, title, acquisition_cost, acquisition_date, status,
         listing_price, sale_price, sale_platform, sale_date, tenant_id)
      VALUES
        (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
         @listing_price, @sale_price, @sale_platform, @sale_date, @tenant_id)
    `).run(item);
    return id;
  };
}
