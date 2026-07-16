import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

// ---------------------------------------------------------------------------
// Consent capture (FR13-FR20). Two tables from
// data/migrations/008_consent_capture.sql:
//
//   disclosure_versions -- append-only; "current" == the row with MAX(version)
//   tenant_consents     -- one row per consent action, scoped per
//                          tenant+connection; idx_tenant_consents_active is a
//                          partial UNIQUE index on (connection_id) WHERE
//                          revoked_at IS NULL, so the DB itself guarantees at
//                          most one active (non-revoked) consent row per
//                          connection at a time.
//
// Every function here takes tenantId explicitly and scopes its queries by
// it, mirroring the FR9 isolation pattern used elsewhere in this codebase
// (see lib/tenantAuth.ts). This module does NOT verify that connectionId
// actually belongs to tenantId -- that ownership check is the caller's
// responsibility (see plan.md's "404 per ownership rule" on the consent API
// routes / lib/automationGate.ts), same division of concerns as
// loadClothingItemOrThrow vs. its callers in lib/pairingToken.ts.
// ---------------------------------------------------------------------------

interface DisclosureVersionRow {
  id: string;
  version: number;
  content: string;
  created_at: string;
}

interface TenantConsentRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  disclosure_version: number;
  consented_at: string;
  revoked_at: string | null;
}

export interface DisclosureVersion {
  version: number;
  content: string;
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  connectionId: string;
  disclosureVersion: number;
  consentedAt: string;
}

function toConsentRecord(row: TenantConsentRow): ConsentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    disclosureVersion: row.disclosure_version,
    consentedAt: row.consented_at,
  };
}

/**
 * Thrown by recordConsent when the given disclosure_version does not exist
 * in disclosure_versions at all. Distinguishable from
 * StaleDisclosureVersionError so callers (the API route) can map each to
 * its own 422 error code -- 'invalid_disclosure_version' vs.
 * 'stale_disclosure_version' (plan.md API contract).
 */
export class InvalidDisclosureVersionError extends Error {
  readonly disclosureVersion: number;
  constructor(disclosureVersion: number) {
    super(`Disclosure version does not exist: ${disclosureVersion}`);
    this.name = 'InvalidDisclosureVersionError';
    this.disclosureVersion = disclosureVersion;
  }
}

/**
 * Thrown by recordConsent when the given disclosure_version exists but is
 * not the current (MAX(version)) one -- e.g. the disclosure document was
 * bumped since the client fetched it.
 */
export class StaleDisclosureVersionError extends Error {
  readonly disclosureVersion: number;
  readonly currentVersion: number;
  constructor(disclosureVersion: number, currentVersion: number) {
    super(
      `Disclosure version ${disclosureVersion} is stale; current version is ${currentVersion}`,
    );
    this.name = 'StaleDisclosureVersionError';
    this.disclosureVersion = disclosureVersion;
    this.currentVersion = currentVersion;
  }
}

/**
 * The disclosure_versions row with MAX(version) -- the document tenants
 * must currently consent to. The disclosure document itself is global, not
 * tenant-scoped (only consent records are).
 */
export function getCurrentDisclosureVersion(): DisclosureVersion {
  const row = db
    .prepare('SELECT version, content FROM disclosure_versions ORDER BY version DESC LIMIT 1')
    .get() as Pick<DisclosureVersionRow, 'version' | 'content'> | undefined;

  if (!row) {
    // Should be unreachable in practice -- 008_consent_capture.sql seeds
    // version 1 unconditionally -- but fail loudly rather than silently
    // treating "no disclosure document" as "no consent required".
    throw new Error('No disclosure_versions row exists');
  }

  return { version: row.version, content: row.content };
}

/**
 * Record a tenant's consent to automate a specific platform connection.
 *
 * Validates disclosureVersion is an integer that (a) exists in
 * disclosure_versions, else throws InvalidDisclosureVersionError, and (b)
 * matches the current MAX(version) row, else throws
 * StaleDisclosureVersionError. On success, atomically revokes any
 * currently-active consent for this connection and inserts the new one --
 * re-consenting after a disclosure-version bump REPLACES the stale consent
 * rather than erroring against idx_tenant_consents_active.
 */
export function recordConsent(
  tenantId: string,
  connectionId: string,
  disclosureVersion: number,
): ConsentRecord {
  if (!Number.isInteger(disclosureVersion)) {
    throw new InvalidDisclosureVersionError(disclosureVersion);
  }

  const versionRow = db
    .prepare('SELECT version FROM disclosure_versions WHERE version = ?')
    .get(disclosureVersion) as { version: number } | undefined;
  if (!versionRow) {
    throw new InvalidDisclosureVersionError(disclosureVersion);
  }

  const current = getCurrentDisclosureVersion();
  if (disclosureVersion !== current.version) {
    throw new StaleDisclosureVersionError(disclosureVersion, current.version);
  }

  const id = uuidv4();

  // Single transaction: revoking the prior active consent (if any) and
  // inserting the new one must be atomic, mirroring the
  // "end prior active, then insert" idiom in lib/pairingToken.ts's
  // createToken. Without this, idx_tenant_consents_active (the partial
  // unique index on connection_id WHERE revoked_at IS NULL) would reject
  // the new insert as a constraint violation whenever a non-revoked
  // consent already exists for this connection.
  db.transaction(() => {
    db.prepare(
      `UPDATE tenant_consents SET revoked_at = datetime('now')
       WHERE tenant_id = ? AND connection_id = ? AND revoked_at IS NULL`,
    ).run(tenantId, connectionId);

    db.prepare(
      `INSERT INTO tenant_consents (id, tenant_id, connection_id, disclosure_version)
       VALUES (?, ?, ?, ?)`,
    ).run(id, tenantId, connectionId, disclosureVersion);
  })();

  const row = db.prepare('SELECT * FROM tenant_consents WHERE id = ?').get(id) as
    | TenantConsentRow
    | undefined;
  if (!row) {
    throw new Error('Failed to read back inserted consent row');
  }

  return toConsentRecord(row);
}

/**
 * Revoke the current (non-revoked) consent for a tenant+connection, if any.
 * Idempotent: a no-op (not an error) when there is nothing to revoke.
 */
export function revokeConsent(tenantId: string, connectionId: string): void {
  db.prepare(
    `UPDATE tenant_consents SET revoked_at = datetime('now')
     WHERE tenant_id = ? AND connection_id = ? AND revoked_at IS NULL`,
  ).run(tenantId, connectionId);
}

/**
 * True only if a non-revoked tenant_consents row exists for this
 * tenant+connection AND its disclosure_version equals the current
 * MAX(version) row (FR16) -- a stale-but-not-revoked consent left over
 * from before a disclosure-version bump does not count as valid.
 */
export function hasValidConsent(tenantId: string, connectionId: string): boolean {
  const row = db
    .prepare(
      `SELECT disclosure_version FROM tenant_consents
       WHERE tenant_id = ? AND connection_id = ? AND revoked_at IS NULL`,
    )
    .get(tenantId, connectionId) as { disclosure_version: number } | undefined;

  if (!row) {
    return false;
  }

  const current = getCurrentDisclosureVersion();
  return row.disclosure_version === current.version;
}
