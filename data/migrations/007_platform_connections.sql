-- Column is named `status`, not `connection_status` -- matches the bare-
-- `status` naming convention already established on items.status and
-- phone_pairing_tokens.status elsewhere in this codebase. ("connection
-- status" remains fine as prose/concept language in the plan and API docs.)
CREATE TABLE platform_connections (
  id                   TEXT PRIMARY KEY
                       CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  platform             TEXT NOT NULL,           -- validated against lib/constants.ts
                                                  -- SUPPORTED_PLATFORMS at the app layer,
                                                  -- NOT a DB CHECK enum -- a new connector
                                                  -- platform then ships without the
                                                  -- create-copy-drop-rename protocol
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','revoked')),
  encrypted_credential BLOB NOT NULL             -- AES-256-GCM: iv(12B)||authTag(16B)||ciphertext
                       CHECK (length(encrypted_credential) >= 29),
                                                  -- iv 12B + authTag 16B + >=1B ciphertext = >=29B;
                                                  -- matches this codebase's length-CHECK convention
                                                  -- on other encoded fields (id=36, token_hash=64
                                                  -- in 004_phone_pairing_tokens.sql)
  last_verified_at     TEXT                      -- ISO-8601 datetime; NULL until first verified
                       CHECK (last_verified_at IS NULL OR last_verified_at LIKE '____-__-__%'),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (created_at LIKE '____-__-__%'),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
                       CHECK (updated_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, platform)
);

CREATE INDEX idx_platform_connections_tenant ON platform_connections(tenant_id);

-- Kill-switch audit trail (FR26) -- one row per status transition, append-only,
-- same spirit as price_history logging every previous/new price.
-- ON DELETE CASCADE (here and on tenant_consents.connection_id in
-- 008_consent_capture.sql below): the revoked-connection reconnect path
-- (see API contract, POST /api/connections) deletes the old
-- platform_connections row outright, and foreign_keys=ON (lib/db.ts) would
-- otherwise block that delete while child rows still reference it.
CREATE TABLE connection_status_events (
  id            TEXT PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  from_status   TEXT NOT NULL CHECK (from_status IN ('active','suspended','revoked')),
  to_status     TEXT NOT NULL CHECK (to_status   IN ('active','suspended','revoked')),
  reason        TEXT NOT NULL CHECK (length(reason) <= 500),
                                                  -- e.g. "ebay_api_403_account_suspended" --
                                                  -- capped since this may carry text derived
                                                  -- from a remote platform's error response,
                                                  -- which has no bound today
  detected_at   TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (detected_at LIKE '____-__-__%'),
  CHECK (from_status != to_status)               -- rejects meaningless no-op audit rows
);

CREATE INDEX idx_connection_status_events_connection
  ON connection_status_events(connection_id, detected_at DESC);
