CREATE TABLE disclosure_versions (
  id         TEXT PRIMARY KEY
             CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  version    INTEGER NOT NULL UNIQUE,     -- monotonic; "current" = row with MAX(version)
  content    TEXT NOT NULL,               -- ToS/ban-risk disclosure text
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
             CHECK (created_at LIKE '____-__-__%')
);

INSERT INTO disclosure_versions (id, version, content, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', 1,
        'Automating a marketplace account through this app may violate that ' ||
        'marketplace''s Terms of Service and can result in suspension or ' ||
        'permanent ban of the connected account. You are solely responsible ' ||
        'for that risk.',
        datetime('now'));

-- ON DELETE CASCADE: see the matching note on connection_status_events in
-- 007_platform_connections.sql -- the revoked-connection reconnect path
-- deletes the old platform_connections row, and its now-stale consent
-- records must go with it for that delete to succeed under foreign_keys=ON.
CREATE TABLE tenant_consents (
  id                 TEXT PRIMARY KEY
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  connection_id      TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  disclosure_version INTEGER NOT NULL REFERENCES disclosure_versions(version),
  consented_at       TEXT NOT NULL DEFAULT (datetime('now'))
                     CHECK (consented_at LIKE '____-__-__%'),
  revoked_at         TEXT
                     CHECK (revoked_at IS NULL OR revoked_at LIKE '____-__-__%')
);

CREATE INDEX idx_tenant_consents_connection ON tenant_consents(connection_id, consented_at DESC);
CREATE INDEX idx_tenant_consents_tenant     ON tenant_consents(tenant_id);
-- Mirrors the idx_ppt_item_active partial-unique-index precedent in
-- 004_phone_pairing_tokens.sql: makes "the current consent row" for a
-- connection unambiguous. Without this, nothing stops two simultaneously-
-- active (non-revoked) consent rows existing for the same connection.
CREATE UNIQUE INDEX idx_tenant_consents_active ON tenant_consents(connection_id)
  WHERE revoked_at IS NULL;
