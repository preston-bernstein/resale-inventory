CREATE TABLE IF NOT EXISTS poshmark_delist_events (
  id            TEXT NOT NULL PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delisted_at   TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (delisted_at = strftime('%Y-%m-%d %H:%M:%S', delisted_at))
);
CREATE INDEX IF NOT EXISTS idx_poshmark_delist_conn_item
  ON poshmark_delist_events(connection_id, item_id, delisted_at DESC);

CREATE TABLE IF NOT EXISTS poshmark_share_events (
  id            TEXT NOT NULL PRIMARY KEY
                CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  connection_id TEXT NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  shared_at     TEXT NOT NULL DEFAULT (datetime('now'))
                CHECK (shared_at = strftime('%Y-%m-%d %H:%M:%S', shared_at))
);
CREATE INDEX IF NOT EXISTS idx_poshmark_share_conn_time
  ON poshmark_share_events(connection_id, shared_at DESC);
