import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import db from '../lib/db';
import {
  createToken,
  resolveToken,
  endActiveToken,
  getSessionStatus,
  markFirstAccessed,
  loadClothingItemOrThrow,
  ItemNotFoundError,
  ItemNotClothingError,
} from '../lib/pairingToken';
import { createTestTenant } from './helpers/tenant';
import { DEFAULT_TENANT_ID } from '../lib/constants';
import { clearItemTables, createBareItemInserter } from './pairingItems';

/**
 * Tests for lib/pairingToken.ts.
 *
 * Follows the same shared-scratch-DB convention as
 * tests/phone-pairing-tokens.test.ts: pairingToken.ts imports the `db`
 * singleton directly (not an injected instance), so these tests run
 * against the same BOOKSELLER_DB_PATH-configured scratch DB via `../lib/db`.
 */
beforeEach(clearItemTables);

const insertTestItem = createBareItemInserter('clothing');

// ---------------------------------------------------------------------
// createToken
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — createToken', () => {
  it('returns a raw token that is exactly 64 lowercase hex chars (32 random bytes)', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns expiresAt ~15 minutes in the future', () => {
    const itemId = insertTestItem();
    const before = Date.now();
    const { expiresAt } = createToken(itemId);
    const after = Date.now();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 15 * 60 * 1000);
  });

  it('stores only the hash, never the raw token, in the DB', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);
    const expectedHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');

    const row = db
      .prepare('SELECT token_hash FROM phone_pairing_tokens WHERE item_id = ?')
      .get(itemId) as { token_hash: string };
    expect(row.token_hash).toBe(expectedHash);
    expect(row.token_hash).not.toBe(token);
  });

  it('ends the prior active token when called again for the same item (no unhandled unique-constraint error)', () => {
    const itemId = insertTestItem();
    const first = createToken(itemId);

    expect(() => createToken(itemId)).not.toThrow();

    const rows = db
      .prepare('SELECT status, token_hash FROM phone_pairing_tokens WHERE item_id = ?')
      .all(itemId) as Array<{ status: string; token_hash: string }>;
    expect(rows).toHaveLength(2);

    const firstHash = crypto.createHash('sha256').update(first.token, 'utf8').digest('hex');
    const firstRow = rows.find((r) => r.token_hash === firstHash);
    const activeRows = rows.filter((r) => r.status === 'active');
    expect(firstRow?.status).toBe('ended');
    expect(activeRows).toHaveLength(1);
  });
});

describe('lib/pairingToken.ts — createToken — purge', () => {
  it('purges rows that expired more than a day ago (hygiene delete)', () => {
    const itemId = insertTestItem();
    const staleId = uuidv4();
    const now = Date.now();
    db.prepare(
      `INSERT INTO phone_pairing_tokens
         (id, item_id, token_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, 'ended', ?, ?)`,
    ).run(staleId, itemId, 'a'.repeat(64), now - 30 * 60 * 60 * 1000, now - 25 * 60 * 60 * 1000);

    createToken(itemId);

    const stale = db
      .prepare('SELECT id FROM phone_pairing_tokens WHERE id = ?')
      .get(staleId);
    expect(stale).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — resolveToken — lookups', () => {
  it('returns the matching row for a valid, active, unexpired token', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);

    const resolved = resolveToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.itemId).toBe(itemId);
    expect(resolved?.status).toBe('active');
    expect(resolved?.firstAccessedAt).toBeNull();
  });

  it('uses a constant-time comparison (crypto.timingSafeEqual), not default string equality', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);

    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    resolveToken(token);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns null if the constant-time comparison reports a mismatch', () => {
    // Defense-in-depth: the SQL WHERE clause already guarantees an exact
    // token_hash match before this comparison ever runs, so it can't fail
    // in normal operation — force it via a mock to prove the fallback
    // actually rejects rather than silently trusting the row it found.
    const itemId = insertTestItem();
    const { token } = createToken(itemId);

    const spy = vi.spyOn(crypto, 'timingSafeEqual').mockReturnValueOnce(false);
    expect(resolveToken(token)).toBeNull();
    spy.mockRestore();
  });

  it('returns null for an unknown token', () => {
    expect(resolveToken('f'.repeat(64))).toBeNull();
  });

  it('returns null for a malformed token (wrong length)', () => {
    expect(resolveToken('abc123')).toBeNull();
  });

  it('returns null for a malformed token (uppercase hex)', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);
    expect(resolveToken(token.toUpperCase())).toBeNull();
  });
});

describe('lib/pairingToken.ts — resolveToken — expiry', () => {
  it('returns null for a malformed token (non-hex characters)', () => {
    expect(resolveToken('z'.repeat(64))).toBeNull();
  });

  it('returns null for an ended token', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);
    endActiveToken(itemId);
    expect(resolveToken(token)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const itemId = insertTestItem();
    const { token } = createToken(itemId);
    // Simulate time passage: push both created_at and expires_at into the
    // past (expires_at must stay > created_at per the CHECK constraint),
    // ending with expires_at still before now.
    db.prepare(
      'UPDATE phone_pairing_tokens SET created_at = ?, expires_at = ? WHERE item_id = ?',
    ).run(Date.now() - 20 * 60 * 1000, Date.now() - 1000, itemId);
    expect(resolveToken(token)).toBeNull();
  });

  it('is still valid at the exact millisecond of expires_at (expiry is exclusive, not inclusive)', () => {
    const itemId = insertTestItem();
    const { token, expiresAt } = createToken(itemId);

    const spy = vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
    try {
      expect(resolveToken(token)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('is expired one millisecond after expires_at', () => {
    const itemId = insertTestItem();
    const { token, expiresAt } = createToken(itemId);

    const spy = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    try {
      expect(resolveToken(token)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------
// endActiveToken
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — endActiveToken', () => {
  it("marks the item's active row as status='ended'", () => {
    const itemId = insertTestItem();
    createToken(itemId);
    endActiveToken(itemId);

    const row = db
      .prepare('SELECT status FROM phone_pairing_tokens WHERE item_id = ?')
      .get(itemId) as { status: string };
    expect(row.status).toBe('ended');
  });

  it('is a no-op (does not throw) when there is no active row', () => {
    const itemId = insertTestItem();
    expect(() => endActiveToken(itemId)).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// getSessionStatus
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — getSessionStatus', () => {
  it("returns 'none' when the item has never had a token", () => {
    const itemId = insertTestItem();
    expect(getSessionStatus(itemId)).toEqual({
      status: 'none',
      expiresAt: null,
      tokenId: null,
    });
  });

  it("returns 'waiting' for a fresh active token with no first access", () => {
    const itemId = insertTestItem();
    const { expiresAt } = createToken(itemId);
    const result = getSessionStatus(itemId);
    expect(result.status).toBe('waiting');
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.tokenId).not.toBeNull();
  });

  it("returns 'connected' once the active token has a first access", () => {
    const itemId = insertTestItem();
    createToken(itemId);
    const { tokenId } = getSessionStatus(itemId);
    markFirstAccessed(tokenId as string);

    const result = getSessionStatus(itemId);
    expect(result.status).toBe('connected');
  });

  it("returns 'expired' for an active token past its expiry", () => {
    const itemId = insertTestItem();
    createToken(itemId);
    db.prepare(
      'UPDATE phone_pairing_tokens SET created_at = ?, expires_at = ? WHERE item_id = ?',
    ).run(Date.now() - 20 * 60 * 1000, Date.now() - 1000, itemId);

    const result = getSessionStatus(itemId);
    expect(result.status).toBe('expired');
  });

  it("returns 'ended' when the most recent token was explicitly ended", () => {
    const itemId = insertTestItem();
    createToken(itemId);
    endActiveToken(itemId);

    const result = getSessionStatus(itemId);
    expect(result.status).toBe('ended');
    expect(result.tokenId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// markFirstAccessed
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — markFirstAccessed', () => {
  it('sets first_accessed_at when currently null', () => {
    const itemId = insertTestItem();
    createToken(itemId);
    const { tokenId: id } = getSessionStatus(itemId);

    markFirstAccessed(id as string);

    const row = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE id = ?')
      .get(id) as { first_accessed_at: number | null };
    expect(row.first_accessed_at).not.toBeNull();
  });

  it('does not overwrite an existing first_accessed_at on repeat calls', () => {
    const itemId = insertTestItem();
    createToken(itemId);
    const { tokenId: id } = getSessionStatus(itemId);

    markFirstAccessed(id as string);
    const firstRow = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE id = ?')
      .get(id) as { first_accessed_at: number };

    markFirstAccessed(id as string);
    const secondRow = db
      .prepare('SELECT first_accessed_at FROM phone_pairing_tokens WHERE id = ?')
      .get(id) as { first_accessed_at: number };

    expect(secondRow.first_accessed_at).toBe(firstRow.first_accessed_at);
  });
});

// ---------------------------------------------------------------------
// loadClothingItemOrThrow
// ---------------------------------------------------------------------
describe('lib/pairingToken.ts — loadClothingItemOrThrow — lookup and errors', () => {
  it('returns the item when it exists, is clothing, and belongs to the calling tenant', () => {
    const itemId = insertTestItem({ category: 'clothing' });
    const item = loadClothingItemOrThrow(itemId, DEFAULT_TENANT_ID);
    expect(item).toEqual({ id: itemId, category: 'clothing' });
  });

  it('throws ItemNotFoundError for a missing item id', () => {
    expect(() => loadClothingItemOrThrow(uuidv4(), DEFAULT_TENANT_ID)).toThrow(
      ItemNotFoundError,
    );
  });

  it('ItemNotFoundError carries a descriptive name and message', () => {
    const missingId = uuidv4();
    try {
      loadClothingItemOrThrow(missingId, DEFAULT_TENANT_ID);
      expect.fail('expected loadClothingItemOrThrow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ItemNotFoundError);
      expect((err as ItemNotFoundError).name).toBe('ItemNotFoundError');
      expect((err as ItemNotFoundError).message).toBe(`Item not found: ${missingId}`);
    }
  });

  it('throws ItemNotClothingError for a non-clothing item owned by the calling tenant', () => {
    const itemId = insertTestItem({ category: 'book', title: 'Some Book' });
    expect(() => loadClothingItemOrThrow(itemId, DEFAULT_TENANT_ID)).toThrow(
      ItemNotClothingError,
    );
  });

  it('ItemNotClothingError carries a descriptive name and message', () => {
    const itemId = insertTestItem({ category: 'book', title: 'Some Book' });
    try {
      loadClothingItemOrThrow(itemId, DEFAULT_TENANT_ID);
      expect.fail('expected loadClothingItemOrThrow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ItemNotClothingError);
      expect((err as ItemNotClothingError).name).toBe('ItemNotClothingError');
      expect((err as ItemNotClothingError).message).toBe(
        "Photos are not supported for category 'book'.",
      );
    }
  });
});

describe('lib/pairingToken.ts — loadClothingItemOrThrow — error details', () => {
  it('ItemNotClothingError carries the offending category', () => {
    const itemId = insertTestItem({ category: 'book', title: 'Some Book' });
    try {
      loadClothingItemOrThrow(itemId, DEFAULT_TENANT_ID);
      expect.fail('expected loadClothingItemOrThrow to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ItemNotClothingError);
      expect((err as ItemNotClothingError).category).toBe('book');
    }
  });

    // -----------------------------------------------------------------
  // Cross-tenant isolation (this task's carve-out: loadClothingItemOrThrow
  // gains a tenantId parameter so phone-pairing can't be issued against
  // another tenant's item -- docs/reseller-multi-tenant-foundation/plan.md
  // Integration points).
  // -----------------------------------------------------------------
  it("throws ItemNotFoundError (not a distinguishing error) for an item owned by a different tenant", () => {
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const itemId = insertTestItem({ category: 'clothing', tenant_id: tenantA.tenantId });

    // Tenant B cannot reach tenant A's item at all -- same error type and
    // message shape as a genuinely missing item, so the response never
    // leaks that the item exists under a different tenant.
    expect(() => loadClothingItemOrThrow(itemId, tenantB.tenantId)).toThrow(ItemNotFoundError);
    try {
      loadClothingItemOrThrow(itemId, tenantB.tenantId);
      expect.fail('expected loadClothingItemOrThrow to throw');
    } catch (err) {
      expect((err as ItemNotFoundError).message).toBe(`Item not found: ${itemId}`);
    }

    // The owning tenant, meanwhile, can load it normally.
    expect(loadClothingItemOrThrow(itemId, tenantA.tenantId)).toEqual({
      id: itemId,
      category: 'clothing',
    });
  });
});

describe('lib/pairingToken.ts — loadClothingItemOrThrow — tenant isolation', () => {
  it('a pairing token minted for tenant A cannot be leveraged against tenant B (full issuance chain)', () => {
    // Exercises the real security boundary end to end: even though
    // resolveToken()/createToken() are itemId-only and have no notion of
    // tenant, the ISSUING side must call loadClothingItemOrThrow with the
    // issuing tenant's id first -- so a caller who does not own the item
    // never reaches createToken() at all, and no token is ever minted
    // that could resolve to another tenant's item.
    const tenantA = createTestTenant();
    const tenantB = createTestTenant();
    const itemId = insertTestItem({ category: 'clothing', tenant_id: tenantA.tenantId });

    // Simulates tenant B's browser hitting the issuing route
    // (app/api/items/[id]/phone-session/route.ts) for tenant A's item id.
    expect(() => loadClothingItemOrThrow(itemId, tenantB.tenantId)).toThrow(ItemNotFoundError);

    // Tenant A can issue normally, and the resulting token resolves back
    // to exactly the item tenant A owns -- resolveToken()'s itemId
    // binding is what makes the token unusable for any other item.
    loadClothingItemOrThrow(itemId, tenantA.tenantId);
    const { token } = createToken(itemId);
    const resolved = resolveToken(token);
    expect(resolved?.itemId).toBe(itemId);
  });
});

