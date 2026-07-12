CREATE TABLE phone_pairing_tokens (
  id                 TEXT    PRIMARY KEY                 -- UUIDv4
                     CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  item_id            TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  token_hash         TEXT    NOT NULL UNIQUE              -- sha256(raw token), hex; raw token
                     CHECK (length(token_hash) = 64),      -- is returned to the caller once and
                                                            -- never stored
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','ended')),
  created_at         INTEGER NOT NULL,                    -- epoch ms, set by app (Date.now())
  expires_at         INTEGER NOT NULL                     -- epoch ms, created_at + 15 min
                     CHECK (expires_at > created_at),
  first_accessed_at  INTEGER                               -- epoch ms, set on first successful GET
                     CHECK (first_accessed_at IS NULL       -- by the phone; NULL = "waiting",
                            OR first_accessed_at BETWEEN created_at AND expires_at)
                                                            -- non-NULL = "connected"
);

CREATE UNIQUE INDEX idx_ppt_item_active ON phone_pairing_tokens(item_id) WHERE status = 'active';
CREATE INDEX idx_ppt_item_created ON phone_pairing_tokens(item_id, created_at DESC);
CREATE INDEX idx_ppt_expires_at ON phone_pairing_tokens(expires_at);
