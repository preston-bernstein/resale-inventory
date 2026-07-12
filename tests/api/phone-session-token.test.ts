import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { createToken, resolveToken, endActiveToken } from '@/lib/pairingToken';
import { GET } from '@/app/api/phone-session/[token]/route';

/**
 * Tests for GET /api/phone-session/[token].
 *
 * Follows the shared-scratch-DB convention used across tests/api/*.test.ts:
 * the route imports the `db` singleton directly, so these tests run against
 * the same BOOKSELLER_DB_PATH-configured scratch DB via `@/lib/db`.
 */
describe('GET /api/phone-session/[token]', () => {
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

  function insertClothingItem(overrides: Record<string, unknown> = {}): string {
    const id = uuidv4();
    const defaults: Record<string, unknown> = {
      id,
      title: 'Test Clothing Item',
      acquisition_cost: 2000,
      acquisition_date: '2024-01-01',
      status: 'Unlisted',
      listing_price: null,
      sale_price: null,
      sale_platform: null,
      sale_date: null,
      brand: 'TestBrand',
      size_label: 'M',
      condition: 'EUC',
    };
    const item = { ...defaults, ...overrides, id, category: 'clothing' };
    db.prepare(
      `INSERT INTO items
         (id, category, title, acquisition_cost, acquisition_date, status,
          listing_price, sale_price, sale_platform, sale_date)
       VALUES
         (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
          @listing_price, @sale_price, @sale_platform, @sale_date)`,
    ).run(item);
    db.prepare(
      `INSERT INTO clothing_details (item_id, brand, size_label, condition)
       VALUES (@id, @brand, @size_label, @condition)`,
    ).run(item);
    return id;
  }

  function req(token: string) {
    return new NextRequest(`http://localhost/api/phone-session/${token}`, { method: 'GET' });
  }

  function callGet(token: string) {
    return GET(req(token), { params: Promise.resolve({ token }) });
  }

  it('valid token returns 200 with item identifying fields and expires_at', async () => {
    const itemId = insertClothingItem({ title: 'Denim Jacket', brand: 'Levi\'s', size_label: 'L' });
    const { token, expiresAt } = createToken(itemId);

    const res = await callGet(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      item: { id: itemId, title: 'Denim Jacket', brand: "Levi's", size_label: 'L' },
      expires_at: expiresAt,
    });
  });

  it('sets first_accessed_at on first access', async () => {
    const itemId = insertClothingItem();
    const { token } = createToken(itemId);

    const beforeResolved = resolveToken(token);
    expect(beforeResolved?.firstAccessedAt).toBeNull();

    const res = await callGet(token);
    expect(res.status).toBe(200);

    const row = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE item_id = ?')
      .get(itemId) as { first_accessed_at: number | null };
    expect(row.first_accessed_at).not.toBeNull();
  });

  it('calling twice with the same valid token keeps first_accessed_at stable (idempotent)', async () => {
    const itemId = insertClothingItem();
    const { token } = createToken(itemId);

    const firstRes = await callGet(token);
    expect(firstRes.status).toBe(200);
    const firstRow = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE item_id = ?')
      .get(itemId) as { first_accessed_at: number };

    const secondRes = await callGet(token);
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    const secondRow = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE item_id = ?')
      .get(itemId) as { first_accessed_at: number };

    expect(secondRow.first_accessed_at).toBe(firstRow.first_accessed_at);
    // Second call still resolves successfully with the same item payload.
    expect(secondBody.item.id).toBe(itemId);
  });

  it('unknown token returns generic 404 with no item data', async () => {
    const res = await callGet('f'.repeat(64));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'This link is no longer valid.' });
    expect(body.item).toBeUndefined();
  });

  it('malformed token returns generic 404', async () => {
    const res = await callGet('not-a-valid-token');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'This link is no longer valid.' });
  });

  it('expired token returns generic 404', async () => {
    const itemId = insertClothingItem();
    const { token } = createToken(itemId);
    db.prepare(
      'UPDATE phone_pairing_tokens SET created_at = ?, expires_at = ? WHERE item_id = ?',
    ).run(Date.now() - 20 * 60 * 1000, Date.now() - 1000, itemId);

    const res = await callGet(token);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'This link is no longer valid.' });
  });

  it('ended token returns generic 404', async () => {
    const itemId = insertClothingItem();
    const { token } = createToken(itemId);
    endActiveToken(itemId);

    const res = await callGet(token);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'This link is no longer valid.' });
  });

  it('all failure responses share the exact same body regardless of cause', async () => {
    const itemId = insertClothingItem();
    const { token: endedToken } = createToken(itemId);
    endActiveToken(itemId);

    const [unknown, malformed, ended] = await Promise.all([
      callGet('a'.repeat(64)),
      callGet('short'),
      callGet(endedToken),
    ]);
    const bodies = await Promise.all([unknown.json(), malformed.json(), ended.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });
});
