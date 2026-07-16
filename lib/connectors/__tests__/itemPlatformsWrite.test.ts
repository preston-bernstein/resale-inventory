import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { DEFAULT_TENANT_ID } from '@/lib/constants';
import { recordListingCreated } from '../itemPlatformsWrite';

// Mirrors tests/integration.test.ts / lib/__tests__/dashboard.test.ts's
// truncate-before-each convention against the shared scratch DB
// (BOOKSELLER_DB_PATH, vitest.config.ts) -- item_platforms depends on items
// via a FK + tenant-match trigger (006_tenant_scoping.sql), so both tables
// are cleared here to keep each test isolated.
beforeEach(() => {
  db.exec(
    'DELETE FROM item_platforms; DELETE FROM item_photos; DELETE FROM price_history; ' +
      'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
});

function insertItem(): string {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO items (id, category, title, acquisition_cost, acquisition_date, status)
     VALUES (?, 'book', 'Test Book', 1000, '2024-01-01', 'Unlisted')`,
  ).run(id);
  return id;
}

interface ItemPlatformRow {
  id: string;
  item_id: string;
  tenant_id: string;
  platform: string;
  external_listing_id: string | null;
  listed_at: string;
}

describe('recordListingCreated', () => {
  it('inserts exactly one row on the first call for a new item+platform pair', () => {
    const itemId = insertItem();

    recordListingCreated(DEFAULT_TENANT_ID, itemId, 'ebay', 'EBAY-LISTING-1');

    const rows = db
      .prepare('SELECT * FROM item_platforms WHERE item_id = ? AND platform = ?')
      .all(itemId, 'ebay') as ItemPlatformRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0].external_listing_id).toBe('EBAY-LISTING-1');
    expect(rows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
  });

  it('updates external_listing_id on a second call for the same item+platform pair instead of inserting a duplicate row', () => {
    const itemId = insertItem();

    recordListingCreated(DEFAULT_TENANT_ID, itemId, 'ebay', 'EBAY-LISTING-1');
    recordListingCreated(DEFAULT_TENANT_ID, itemId, 'ebay', 'EBAY-LISTING-2');

    const rows = db
      .prepare('SELECT * FROM item_platforms WHERE item_id = ? AND platform = ?')
      .all(itemId, 'ebay') as ItemPlatformRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0].external_listing_id).toBe('EBAY-LISTING-2');
  });

  it('sets tenant_id to the passed tenantId', () => {
    const itemId = insertItem();

    recordListingCreated(DEFAULT_TENANT_ID, itemId, 'poshmark', 'POSH-1');

    const row = db
      .prepare('SELECT * FROM item_platforms WHERE item_id = ? AND platform = ?')
      .get(itemId, 'poshmark') as ItemPlatformRow;

    expect(row.tenant_id).toBe(DEFAULT_TENANT_ID);
  });
});
