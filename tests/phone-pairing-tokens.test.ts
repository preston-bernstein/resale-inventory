import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import db from '../lib/db';

/**
 * Tests for phone_pairing_tokens migration (004).
 *
 * Verifies:
 * 1. Table exists with correct schema
 * 2. Unique partial index on (item_id) WHERE status='active' enforces at most one active token per item
 * 3. Insertions and constraint violations work as expected
 */
describe('phone_pairing_tokens migration (004)', () => {
  beforeEach(() => {
    // Delete child tables before items, matching this repo's established
    // cleanup order (see tests/api/items-photos.test.ts) — items may be
    // referenced by satellite tables left over from other test files
    // sharing the same scratch DB, and foreign_keys=ON rejects a blanket
    // DELETE FROM items while any of those rows still point at it.
    db.exec(
      'DELETE FROM phone_pairing_tokens; DELETE FROM item_photos; ' +
        'DELETE FROM price_history; DELETE FROM item_platforms; ' +
        'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
    );
  });

  /**
   * Insert a test item (needed for FK constraint).
   * Returns the item id.
   */
  function insertTestItem(overrides: Record<string, unknown> = {}): string {
    const id = uuidv4();
    const defaults: Record<string, unknown> = {
      id,
      category: 'book',
      title: 'Test Item',
      acquisition_cost: 1000,
      acquisition_date: '2024-01-01',
      status: 'Unlisted',
      listing_price: null,
      sale_price: null,
      sale_platform: null,
      sale_date: null,
    };
    const item = { ...defaults, ...overrides, id };
    db.prepare(`
      INSERT INTO items
        (id, category, title, acquisition_cost, acquisition_date, status,
         listing_price, sale_price, sale_platform, sale_date)
      VALUES
        (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
         @listing_price, @sale_price, @sale_platform, @sale_date)
    `).run(item);
    return id;
  }

  it('table phone_pairing_tokens exists after migration', () => {
    const schema = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='phone_pairing_tokens'",
    ).all();
    expect(schema).toHaveLength(1);
  });

  it('indexes idx_ppt_item_active, idx_ppt_item_created, and idx_ppt_expires_at exist', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_ppt_%'",
    ).all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name).sort();
    expect(names).toContain('idx_ppt_item_active');
    expect(names).toContain('idx_ppt_item_created');
    expect(names).toContain('idx_ppt_expires_at');
  });

  it('can insert a single active token for an item', () => {
    const itemId = insertTestItem();
    const tokenId = uuidv4();
    const tokenHash = '0'.repeat(64); // Valid 64-char hex (sha256)
    const now = Date.now();
    const expires = now + 15 * 60 * 1000; // 15 min from now

    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(tokenId, itemId, tokenHash, now, expires);
    }).not.toThrow();

    const row = db.prepare(
      'SELECT id, item_id, status FROM phone_pairing_tokens WHERE id = ?',
    ).get(tokenId) as { id: string; item_id: string; status: string };
    expect(row.id).toBe(tokenId);
    expect(row.item_id).toBe(itemId);
    expect(row.status).toBe('active');
  });

  it('unique partial index idx_ppt_item_active prevents two active tokens for the same item', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;

    // Insert first active token
    const token1Id = uuidv4();
    const token1Hash = '1'.repeat(64);
    db.prepare(`
      INSERT INTO phone_pairing_tokens
        (id, item_id, token_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(token1Id, itemId, token1Hash, now, expires);

    // Attempt to insert second active token for same item → should fail
    const token2Id = uuidv4();
    const token2Hash = '2'.repeat(64);
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(token2Id, itemId, token2Hash, now, expires);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('can insert ended token for same item as active token (partial index does not cover ended)', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;

    // Insert active token
    const activeTokenId = uuidv4();
    const activeTokenHash = 'a'.repeat(64);
    db.prepare(`
      INSERT INTO phone_pairing_tokens
        (id, item_id, token_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(activeTokenId, itemId, activeTokenHash, now, expires);

    // Insert ended token for same item → should succeed (partial index only covers active)
    const endedTokenId = uuidv4();
    const endedTokenHash = 'b'.repeat(64);
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'ended', ?, ?)
      `).run(endedTokenId, itemId, endedTokenHash, now, expires);
    }).not.toThrow();

    const rows = db.prepare(
      'SELECT id, status FROM phone_pairing_tokens WHERE item_id = ? ORDER BY status',
    ).all(itemId) as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('active');
    expect(rows[1].status).toBe('ended');
  });

  it('foreign key constraint: deleting an item cascades to delete its tokens', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;

    const tokenId = uuidv4();
    const tokenHash = 'c'.repeat(64);
    db.prepare(`
      INSERT INTO phone_pairing_tokens
        (id, item_id, token_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(tokenId, itemId, tokenHash, now, expires);

    // Delete the item → token should be deleted too (ON DELETE CASCADE)
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);

    const remaining = db.prepare(
      'SELECT COUNT(*) as count FROM phone_pairing_tokens WHERE item_id = ?',
    ).get(itemId) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('token_hash UNIQUE constraint: duplicate hashes rejected regardless of item', () => {
    const item1 = insertTestItem({ title: 'Item 1' });
    const item2 = insertTestItem({ title: 'Item 2' });
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;
    const sharedHash = 'd'.repeat(64);

    // Insert token for item1
    const token1Id = uuidv4();
    db.prepare(`
      INSERT INTO phone_pairing_tokens
        (id, item_id, token_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(token1Id, item1, sharedHash, now, expires);

    // Attempt same hash for item2 → should fail (token_hash is UNIQUE globally)
    const token2Id = uuidv4();
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(token2Id, item2, sharedHash, now, expires);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('CHECK constraints: id must be valid UUIDv4 (length 36, position 15 = "4")', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;
    const tokenHash = 'e'.repeat(64);

    // Invalid: wrong length
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run('invalid-id', itemId, tokenHash, now, expires);
    }).toThrow(/CHECK constraint failed/);

    // Invalid: correct length but wrong version digit
    const badUuid = 'a'.repeat(14) + '3' + 'a'.repeat(21); // version 3, not 4
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(badUuid, itemId, tokenHash, now, expires);
    }).toThrow(/CHECK constraint failed/);
  });

  it('CHECK constraints: token_hash must be 64 chars (sha256 hex)', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;
    const validId = uuidv4();

    // Too short
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(validId, itemId, 'f'.repeat(63), now, expires);
    }).toThrow(/CHECK constraint failed/);

    // Too long
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(validId, itemId, 'f'.repeat(65), now, expires);
    }).toThrow(/CHECK constraint failed/);
  });

  it('CHECK constraints: status must be "active" or "ended"', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;
    const validId = uuidv4();
    const validHash = 'a'.repeat(64);

    // Invalid status
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'invalid', ?, ?)
      `).run(validId, itemId, validHash, now, expires);
    }).toThrow(/CHECK constraint failed/);
  });

  it('CHECK constraints: expires_at > created_at', () => {
    const itemId = insertTestItem();
    const now = Date.now();
    const validId = uuidv4();
    const validHash = 'b'.repeat(64);

    // expires_at not greater than created_at
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(validId, itemId, validHash, now, now);
    }).toThrow(/CHECK constraint failed/);
  });

  it('CHECK constraints: first_accessed_at must be between created_at and expires_at or NULL', () => {
    const now = Date.now();
    const expires = now + 15 * 60 * 1000;

    // NULL is OK
    const item1 = insertTestItem({ title: 'Item for NULL check' });
    const validId = uuidv4();
    const validHash = 'c'.repeat(64);
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
        VALUES (?, ?, ?, 'active', ?, ?, NULL)
      `).run(validId, item1, validHash, now, expires);
    }).not.toThrow();

    // Within range is OK
    const item2 = insertTestItem({ title: 'Item for within-range check' });
    const validId2 = uuidv4();
    const accessTime = now + 5 * 60 * 1000; // 5 min after created
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(validId2, item2, 'd'.repeat(64), now, expires, accessTime);
    }).not.toThrow();

    // Before created_at is not OK
    const item3 = insertTestItem({ title: 'Item for before-created check' });
    const validId3 = uuidv4();
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(validId3, item3, 'e'.repeat(64), now, expires, now - 1000);
    }).toThrow(/CHECK constraint failed/);

    // After expires_at is not OK
    const item4 = insertTestItem({ title: 'Item for after-expires check' });
    const validId4 = uuidv4();
    expect(() => {
      db.prepare(`
        INSERT INTO phone_pairing_tokens
          (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(validId4, item4, 'f'.repeat(64), now, expires, expires + 1000);
    }).toThrow(/CHECK constraint failed/);
  });
});
