import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { encryptCredential, decryptCredential } from '@/lib/credentialCrypto';

// platform_connections CRUD (data/migrations/007_platform_connections.sql).
// Every function below takes tenantId as an explicit first parameter and
// includes it in every WHERE clause (FR9) -- isolation must not depend
// solely on application code remembering to filter elsewhere.
//
// This file's job is plain CRUD + the encryption/decryption boundary only.
// The revoked-connection reconnect path (delete-old-row-then-insert) and the
// credential-rotation HTTP route both live in future route-layer code, which
// composes deleteConnection()/createConnection() itself -- this file doesn't
// know about that dance.
//
// recordSuspensionSignal/reactivateConnection (the kill-switch functions,
// FR21-FR28) live at the bottom of this file. Both take tenantId first and
// re-verify ownership inside their own db.transaction(), same isolation
// discipline as the CRUD functions above.

export class ConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionValidationError';
  }
}

interface PlatformConnectionRow {
  id: string;
  tenant_id: string;
  platform: string;
  status: string;
  encrypted_credential: Buffer;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Non-secret metadata for a connection -- the ONLY shape ever returned to callers other than getDecryptedCredential(). */
export interface ConnectionMetadata {
  id: string;
  platform: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toMetadata(row: PlatformConnectionRow): ConnectionMetadata {
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A credential must be a plain, non-null JSON object -- not a string, array,
 * or null (API contract: POST/PATCH /api/connections reject those with 422
 * before this function is ever reached; this is the corresponding
 * lib-layer guard so the invariant holds regardless of caller).
 */
function assertValidCredentialShape(credential: unknown): asserts credential is object {
  if (
    credential === null ||
    typeof credential !== 'object' ||
    Array.isArray(credential)
  ) {
    throw new ConnectionValidationError(
      'credential must be a non-null object (not a string, array, or null)',
    );
  }
}

/**
 * Insert a fresh platform_connections row with status='active'. Plain insert
 * only -- callers that need "delete the old revoked row first" (the
 * reconnect path) do that themselves, in their own transaction, before
 * calling this.
 *
 * Returns metadata only; never the credential.
 */
export function createConnection(
  tenantId: string,
  platform: string,
  credential: unknown,
): ConnectionMetadata {
  assertValidCredentialShape(credential);

  const id = uuidv4();
  const encrypted = encryptCredential(credential as object);

  db.prepare(
    `INSERT INTO platform_connections
       (id, tenant_id, platform, status, encrypted_credential)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(id, tenantId, platform, encrypted);

  return getConnection(tenantId, id) as ConnectionMetadata;
}

/**
 * Fetch one connection's metadata, scoped to tenantId. Returns null if the
 * connection doesn't exist or belongs to a different tenant -- callers turn
 * that into a 404, never a 403 (FR4).
 */
export function getConnection(tenantId: string, connectionId: string): ConnectionMetadata | null {
  const row = db
    .prepare('SELECT * FROM platform_connections WHERE id = ? AND tenant_id = ?')
    .get(connectionId, tenantId) as PlatformConnectionRow | undefined;

  return row ? toMetadata(row) : null;
}

/**
 * List all connections' metadata for a tenant.
 */
export function listConnections(tenantId: string): ConnectionMetadata[] {
  const rows = db
    .prepare('SELECT * FROM platform_connections WHERE tenant_id = ? ORDER BY created_at ASC')
    .all(tenantId) as PlatformConnectionRow[];

  return rows.map(toMetadata);
}

/**
 * Return the DECRYPTED credential for a connection, scoped to tenantId.
 * Throws if the connection doesn't exist or belongs to a different tenant.
 *
 * This is the ONLY function in this file that ever returns plaintext
 * credential material. No HTTP-facing route in this increment calls it
 * (FR10 -- a credential must never appear in an API response body); it
 * exists solely for future connector code (eBay API client, Poshmark
 * browser bot, etc.) to authenticate against a marketplace platform.
 */
export function getDecryptedCredential(tenantId: string, connectionId: string): unknown {
  const row = db
    .prepare('SELECT * FROM platform_connections WHERE id = ? AND tenant_id = ?')
    .get(connectionId, tenantId) as PlatformConnectionRow | undefined;

  if (!row) {
    throw new ConnectionValidationError(`Connection not found: ${connectionId}`);
  }

  return JSON.parse(decryptCredential(row.encrypted_credential));
}

/**
 * Re-encrypt and store a new credential for an existing connection, scoped
 * to tenantId. Returns updated metadata, or null if the connection doesn't
 * exist or belongs to a different tenant.
 */
export function rotateCredential(
  tenantId: string,
  connectionId: string,
  newCredential: unknown,
): ConnectionMetadata | null {
  assertValidCredentialShape(newCredential);

  const encrypted = encryptCredential(newCredential as object);

  const result = db
    .prepare(
      `UPDATE platform_connections
         SET encrypted_credential = ?, updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(encrypted, connectionId, tenantId);

  if (result.changes === 0) {
    return null;
  }

  return getConnection(tenantId, connectionId);
}

/**
 * Delete a platform_connections row, scoped to tenantId. ON DELETE CASCADE
 * (connection_status_events.connection_id, tenant_consents.connection_id)
 * cleans up child rows automatically. Returns true if a row was deleted,
 * false if nothing matched (already gone, or owned by a different tenant).
 *
 * Used by the future route-layer's revoked-reconnect logic (delete the old
 * revoked row, then call createConnection() for the fresh one) -- not
 * exposed as a standalone HTTP delete in this increment's API contract.
 */
export function deleteConnection(tenantId: string, connectionId: string): boolean {
  const result = db
    .prepare('DELETE FROM platform_connections WHERE id = ? AND tenant_id = ?')
    .run(connectionId, tenantId);

  return result.changes > 0;
}

/**
 * Thrown by reactivateConnection when the connection is not currently
 * 'suspended' -- either it's already 'active' (nothing to do) or it's
 * 'revoked' (no reactivate path exists for revoked in this increment; see
 * that function's doc comment). Distinguishable from
 * ConnectionValidationError (not-found/wrong-tenant) so callers map this
 * one to 409 not_suspended specifically, per the API contract.
 */
export class ConnectionNotSuspendedError extends Error {
  readonly status: string;
  constructor(connectionId: string, status: string) {
    super(`Connection ${connectionId} is not suspended (current status: ${status})`);
    this.name = 'ConnectionNotSuspendedError';
    this.status = status;
  }
}

/**
 * Kill-switch signal entry point (FR22/FR23). Connector code (future work)
 * calls this synchronously the moment a platform reports a suspension/ban
 * signal. Everything happens inside a single db.transaction(): re-verify
 * the connection exists and belongs to tenantId, transition its status,
 * and insert a connection_status_events audit row (FR26) -- all
 * synchronous, no queuing or background job as the sole enforcement path
 * (NFR). Callers needing the updated metadata can follow up with
 * getConnection(tenantId, connectionId); this function itself returns void
 * per the API contract (plan.md).
 *
 * Throws ConnectionValidationError if the connection doesn't exist or
 * belongs to a different tenant, or if it is already in `toStatus`.
 * connection_status_events has CHECK(from_status != to_status) at the DB
 * layer -- a same-status "signal" isn't a real transition (FR23 says
 * "transition... to suspended", implying an actual change), so this fails
 * loudly with a clear error instead of surfacing an opaque SQLite
 * constraint-violation from the INSERT.
 */
export function recordSuspensionSignal(
  tenantId: string,
  connectionId: string,
  reason: string,
  toStatus: 'suspended' | 'revoked',
): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM platform_connections WHERE id = ? AND tenant_id = ?')
      .get(connectionId, tenantId) as PlatformConnectionRow | undefined;

    if (!row) {
      throw new ConnectionValidationError(`Connection not found: ${connectionId}`);
    }

    const fromStatus = row.status;
    if (fromStatus === toStatus) {
      throw new ConnectionValidationError(
        `Connection ${connectionId} is already ${toStatus}; no transition to record`,
      );
    }

    db.prepare(
      `UPDATE platform_connections SET status = ?, updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ?`,
    ).run(toStatus, connectionId, tenantId);

    db.prepare(
      `INSERT INTO connection_status_events (id, connection_id, from_status, to_status, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(uuidv4(), connectionId, fromStatus, toStatus, reason);
  })();
}

/**
 * Explicit re-activation (FR28) -- the kill-switch must fail closed and
 * never auto-heal, so this is the only path that moves a connection from
 * 'suspended' back to 'active', and it only ever runs when a caller
 * explicitly invokes it. Scoped to tenantId, same transactional pattern as
 * recordSuspensionSignal: re-verify ownership, transition status, insert
 * the audit row, all inside one db.transaction().
 *
 * Throws ConnectionValidationError if the connection doesn't exist or
 * belongs to a different tenant. Throws ConnectionNotSuspendedError if
 * current status is 'active' (nothing to reactivate) or 'revoked' --
 * revoked has no reactivate path in this increment; per plan.md's API
 * contract, the only way back from revoked is a full reconnect
 * (deleteConnection() then createConnection()), which a future route-layer
 * task implements. Either case is a 409 not_suspended to the caller.
 *
 * Returns the updated metadata on success.
 */
export function reactivateConnection(tenantId: string, connectionId: string): ConnectionMetadata {
  db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM platform_connections WHERE id = ? AND tenant_id = ?')
      .get(connectionId, tenantId) as PlatformConnectionRow | undefined;

    if (!row) {
      throw new ConnectionValidationError(`Connection not found: ${connectionId}`);
    }

    if (row.status !== 'suspended') {
      throw new ConnectionNotSuspendedError(connectionId, row.status);
    }

    db.prepare(
      `UPDATE platform_connections SET status = 'active', updated_at = datetime('now')
       WHERE id = ? AND tenant_id = ?`,
    ).run(connectionId, tenantId);

    db.prepare(
      `INSERT INTO connection_status_events (id, connection_id, from_status, to_status, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(uuidv4(), connectionId, 'suspended', 'active', 'manual_reactivation');
  })();

  return getConnection(tenantId, connectionId) as ConnectionMetadata;
}
