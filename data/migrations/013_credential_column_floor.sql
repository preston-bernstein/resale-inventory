-- Migration 013_credential_column_floor.sql
-- Corrects platform_connections.encrypted_credential's minimum-length CHECK
-- for the credential-crypto migration (lib/credentialCrypto.ts now delegates
-- its AEAD call to @preston-bernstein/credential-crypto's XChaCha20-Poly1305
-- encryptBytes/decryptBytes instead of node:crypto's AES-256-GCM). The old
-- format was iv(12B)||authTag(16B)||ciphertext, giving a >=1B-ciphertext
-- floor of 12+16+1=29B (007_platform_connections.sql's original CHECK). The
-- new format is nonce(24B)||ciphertext+tag, whose structural minimum alone
-- is 24+16=40B (see credential-crypto/src/primitives.ts MIN_PACKED_BYTES);
-- applying this codebase's own "+1B ciphertext" floor convention gives 41B.
-- The old `>= 29` constraint is too permissive for the new format -- a
-- 29-40 byte value could pass the old CHECK but is structurally too short
-- to ever be a valid nonce-prefixed XChaCha20-Poly1305 payload.
--
-- SQLite cannot ALTER a CHECK constraint, so this follows the same
-- create-copy-drop-rename protocol as 003_multi_category.sql. Safe to run
-- as a straight rebuild (not an archive-and-defer-drop) because this
-- migration was written and verified against a production database with
-- ZERO existing platform_connections rows (re-confirmed immediately before
-- writing this migration) -- there is no live encrypted_credential data at
-- risk. If this assumption is ever wrong for a given database, the
-- INSERT...SELECT below will itself fail closed: any pre-existing
-- encrypted_credential value between 29 and 40 bytes (valid under the old
-- CHECK, invalid under the new one) violates the new table's CHECK and
-- aborts the whole migration transaction rather than silently truncating
-- or dropping data.
--
-- connection_status_events, tenant_consents, and the Poshmark pacing
-- tables (008_consent_capture.sql, 010_poshmark_pacing.sql) all reference
-- platform_connections(id) BY TABLE NAME, not by an internal identifier --
-- SQLite resolves FK targets by name at each write, so once the rebuilt
-- table is renamed back to `platform_connections`, every dependent FK
-- (all ON DELETE CASCADE) resolves correctly with no changes needed to
-- those tables themselves.

PRAGMA defer_foreign_keys = ON;
-- Scoped to this transaction only -- SQLite resets it to OFF automatically
-- at commit/rollback. Guards the copy step below in case row ordering ever
-- changes; not strictly load-bearing today since nothing here inserts a
-- child row before its parent exists.

CREATE TABLE platform_connections_v2 (
  id                   TEXT PRIMARY KEY
                       CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  platform             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','revoked')),
  encrypted_credential BLOB NOT NULL             -- XChaCha20-Poly1305: nonce(24B)||ciphertext+tag
                       CHECK (length(encrypted_credential) >= 41),
                                                  -- nonce 24B + tag 16B + >=1B ciphertext = >=41B
  last_verified_at     TEXT
                       CHECK (last_verified_at IS NULL OR last_verified_at LIKE '____-__-__%'),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (created_at LIKE '____-__-__%'),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (updated_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, platform)
);

INSERT INTO platform_connections_v2 (id, tenant_id, platform, status, encrypted_credential,
                                      last_verified_at, created_at, updated_at)
  SELECT id, tenant_id, platform, status, encrypted_credential,
         last_verified_at, created_at, updated_at
  FROM platform_connections;

DROP TABLE platform_connections;
ALTER TABLE platform_connections_v2 RENAME TO platform_connections;

CREATE INDEX idx_platform_connections_tenant ON platform_connections(tenant_id);
