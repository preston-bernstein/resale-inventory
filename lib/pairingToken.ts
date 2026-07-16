import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

// 32 random bytes (256 bits), hex-encoded → 64 hex chars. This is the raw
// token handed to the phone; only its SHA-256 hash is ever persisted.
const TOKEN_BYTES = 32;
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;

// Pairing token TTL.
const TTL_MS = 15 * 60 * 1000;

// Hygiene window for createToken's opportunistic cleanup: rows that expired
// more than a day ago are stale enough to purge outright, well clear of any
// row a client could still plausibly be polling against.
const HYGIENE_WINDOW_MS = 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

interface PairingTokenRow {
  id: string;
  item_id: string;
  token_hash: string;
  status: string;
  created_at: number;
  expires_at: number;
  first_accessed_at: number | null;
}

export interface ResolvedToken {
  id: string;
  itemId: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  firstAccessedAt: number | null;
}

function toResolvedToken(row: PairingTokenRow): ResolvedToken {
  return {
    id: row.id,
    itemId: row.item_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    firstAccessedAt: row.first_accessed_at,
  };
}

/**
 * Generate a fresh pairing token for an item, superseding any existing
 * active token for that item. Returns the RAW token — the only time it is
 * ever available; only its hash is stored.
 */
export function createToken(itemId: string): { token: string; expiresAt: number } {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const id = uuidv4();
  const createdAt = Date.now();
  const expiresAt = createdAt + TTL_MS;

  // Single transaction: hygiene delete + ending the prior active token +
  // inserting the new one must be atomic. Without this, a double-click race
  // (two POSTs for the same item landing close together) could both pass
  // the "end prior active" step before either inserts, and the second
  // insert would then trip the idx_ppt_item_active unique partial index as
  // an unhandled constraint-violation 500 instead of cleanly superseding.
  db.transaction(() => {
    db.prepare('DELETE FROM phone_pairing_tokens WHERE expires_at < ?').run(
      Date.now() - HYGIENE_WINDOW_MS,
    );
    db.prepare(
      "UPDATE phone_pairing_tokens SET status = 'ended' WHERE item_id = ? AND status = 'active'",
    ).run(itemId);
    db.prepare(
      `INSERT INTO phone_pairing_tokens
         (id, item_id, token_hash, status, created_at, expires_at, first_accessed_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(id, itemId, tokenHash, createdAt, expiresAt);
  })();

  return { token: rawToken, expiresAt };
}

/**
 * Resolve a raw token presented by a client (e.g. from a QR-code URL) back
 * to its pairing-token row, or null if it's malformed, unknown, ended, or
 * expired.
 */
export function resolveToken(rawToken: string): ResolvedToken | null {
  // Reject malformed input before hashing at all — a valid raw token is
  // always exactly 64 lowercase hex chars (32 random bytes, hex-encoded).
  // Cheap shape check, and it means we never even compute a hash for
  // obviously-bogus input.
  if (!TOKEN_HEX_RE.test(rawToken)) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare('SELECT * FROM phone_pairing_tokens WHERE token_hash = ?')
    .get(tokenHash) as PairingTokenRow | undefined;

  if (!row) {
    return null;
  }

  // Defense-in-depth: the SQL equality lookup above is keyed on an index
  // over token_hash (itself a SHA-256 digest of a 256-bit secret), so it
  // carries no meaningful timing signal an attacker could exploit
  // character-by-character — hashing already destroys any structure to
  // time against. Still, confirm the match with a constant-time comparison
  // rather than trusting `WHERE token_hash = ?` alone, so no code path
  // here relies on default (non-constant-time) string equality over
  // secret-derived bytes.
  const rowHashBuf = Buffer.from(row.token_hash, 'hex');
  const computedHashBuf = Buffer.from(tokenHash, 'hex');
  if (
    rowHashBuf.length !== computedHashBuf.length ||
    !crypto.timingSafeEqual(rowHashBuf, computedHashBuf)
  ) {
    return null;
  }

  if (row.status !== 'active' || Date.now() > row.expires_at) {
    return null;
  }

  return toResolvedToken(row);
}

/**
 * End the item's current active token, if any. No-op if there isn't one.
 */
export function endActiveToken(itemId: string): void {
  db.prepare(
    "UPDATE phone_pairing_tokens SET status = 'ended' WHERE item_id = ? AND status = 'active'",
  ).run(itemId);
}

export type SessionStatusValue = 'none' | 'waiting' | 'connected' | 'ended' | 'expired';

export interface SessionStatus {
  status: SessionStatusValue;
  expiresAt: number | null;
  tokenId: string | null;
}

/**
 * Derive the phone-pairing session status for an item, for the desktop side
 * to poll while waiting for (or after) a phone connects.
 */
export function getSessionStatus(itemId: string): SessionStatus {
  const activeRow = db
    .prepare("SELECT * FROM phone_pairing_tokens WHERE item_id = ? AND status = 'active'")
    .get(itemId) as PairingTokenRow | undefined;

  if (activeRow) {
    let status: SessionStatusValue;
    if (Date.now() > activeRow.expires_at) {
      status = 'expired';
    } else if (activeRow.first_accessed_at === null) {
      status = 'waiting';
    } else {
      status = 'connected';
    }
    return { status, expiresAt: activeRow.expires_at, tokenId: activeRow.id };
  }

  // No active row: fall back to the most recent token of any status for
  // this item (uses idx_ppt_item_created). Anything found here is
  // necessarily 'ended' (the CHECK constraint only allows 'active' or
  // 'ended', and we already ruled out 'active' above).
  const lastRow = db
    .prepare(
      'SELECT * FROM phone_pairing_tokens WHERE item_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(itemId) as PairingTokenRow | undefined;

  if (!lastRow) {
    return { status: 'none', expiresAt: null, tokenId: null };
  }

  return { status: 'ended', expiresAt: lastRow.expires_at, tokenId: lastRow.id };
}

/**
 * Record the first time a token was actually used by a phone. Only sets it
 * once — repeat calls after the first are a no-op, so the timestamp always
 * reflects the true first access.
 */
export function markFirstAccessed(tokenId: string): void {
  db.prepare(
    'UPDATE phone_pairing_tokens SET first_accessed_at = ? WHERE id = ? AND first_accessed_at IS NULL',
  ).run(Date.now(), tokenId);
}

// ---------------------------------------------------------------------------
// loadClothingItemOrThrow — used by the phone-session-issuing route
// (app/api/items/[id]/phone-session/route.ts POST) to load-and-validate an
// item ("exists, and category === 'clothing'") before minting a pairing
// token for it. Throws a typed error so callers can map to the right HTTP
// status without string-matching an error message.
// ---------------------------------------------------------------------------

export class ItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Item not found: ${itemId}`);
    this.name = 'ItemNotFoundError';
  }
}

export class ItemNotClothingError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`Photos are not supported for category '${category}'.`);
    this.name = 'ItemNotClothingError';
    this.category = category;
  }
}

// tenantId scoping: this is called by the ISSUING side (the tenant's own
// browser requesting a new pairing token for one of its own items — see
// app/api/items/[id]/phone-session/route.ts), never by the paired phone
// itself (which has no tenant identity to present). Folding the ownership
// check into the same not-found branch — rather than a distinct 403/404 —
// means an item id that belongs to a different tenant is indistinguishable
// from one that doesn't exist at all, so a pairing token can never be
// issued against another tenant's item and no response ever leaks that
// item's existence, category, or ownership to a caller who doesn't already
// own it.
export function loadClothingItemOrThrow(
  itemId: string,
  tenantId: string,
): { id: string; category: string } {
  const item = db.prepare('SELECT id, category, tenant_id FROM items WHERE id = ?').get(itemId) as
    | { id: string; category: string; tenant_id: string }
    | undefined;

  if (!item || item.tenant_id !== tenantId) {
    throw new ItemNotFoundError(itemId);
  }
  if (item.category !== 'clothing') {
    throw new ItemNotClothingError(item.category);
  }
  return { id: item.id, category: item.category };
}
