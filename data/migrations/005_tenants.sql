CREATE TABLE tenants (
  id            TEXT PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- case-insensitive uniqueness --
                                                        -- otherwise Foo@x.com and foo@x.com
                                                        -- would collide at login but not at
                                                        -- signup, producing duplicate accounts
  password_hash TEXT NOT NULL,        -- scrypt, packed "N:r:p:salt_hex:hash_hex"
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (created_at LIKE '____-__-__%'),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (updated_at LIKE '____-__-__%')
);

-- Epoch-ms INTEGER timestamps here (unlike the TEXT ISO-8601 convention on
-- the other three new tables below) are deliberate, not an oversight -- this
-- mirrors phone_pairing_tokens' existing epoch-ms TTL-arithmetic pattern
-- (created_at/expires_at compared and diffed directly as numbers).
CREATE TABLE tenant_sessions (
  id                 TEXT PRIMARY KEY
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  session_token_hash TEXT NOT NULL UNIQUE     -- sha256(raw token), hex; raw token
                     CHECK (length(session_token_hash) = 64),  -- lives only in the cookie
  created_at         INTEGER NOT NULL,         -- epoch ms
  expires_at         INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at         INTEGER                   -- epoch ms; NULL = valid until expiry
);

-- FR7: the single default tenant all pre-existing inventory rows migrate onto.
-- password_hash is a deliberately unusable placeholder, not a valid scrypt
-- encoding of any real password -- see plan Risk areas re: the operator's
-- one-time credential-claim step.
INSERT INTO tenants (id, email, password_hash, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000000', 'default@local.invalid',
        'unclaimed', datetime('now'), datetime('now'));

CREATE INDEX idx_tenant_sessions_tenant   ON tenant_sessions(tenant_id);
-- No session-cleanup/GC job is built in this increment (out of scope), but
-- this index is added now anyway so a future cleanup job (DELETE WHERE
-- expires_at < ?) is cheap to add later instead of requiring a migration.
CREATE INDEX idx_tenant_sessions_expires  ON tenant_sessions(expires_at);
