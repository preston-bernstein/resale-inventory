PRAGMA defer_foreign_keys = ON;  -- scoped to this transaction only

CREATE TABLE items_v2 (
  id               TEXT    PRIMARY KEY
                   CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  category         TEXT    NOT NULL
                   CHECK (category IN ('book','clothing','electronics')),
  title            TEXT    NOT NULL,
  acquisition_cost INTEGER NOT NULL CHECK (acquisition_cost >= 0),
  acquisition_date TEXT    NOT NULL CHECK (acquisition_date LIKE '____-__-__'),
  status           TEXT    NOT NULL DEFAULT 'Unlisted'
                   CHECK (status IN ('Unlisted','Listed','Sale Pending','Sold',
                                     'Removed','Donated','Discarded')),
  listing_price    INTEGER CHECK (listing_price IS NULL OR listing_price >= 0),
  sale_price       INTEGER CHECK (sale_price IS NULL OR sale_price >= 0),
  sale_platform    TEXT,
  sale_date        TEXT    CHECK (sale_date IS NULL OR sale_date LIKE '____-__-__'),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')) CHECK (created_at LIKE '____-__-__%'),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')) CHECK (updated_at LIKE '____-__-__%'),
  tenant_id        TEXT    NOT NULL REFERENCES tenants(id)
                   DEFAULT '00000000-0000-4000-8000-000000000000',
  CHECK (status NOT IN ('Listed','Sale Pending') OR listing_price IS NOT NULL),
  CHECK (status != 'Sold' OR (sale_price IS NOT NULL AND sale_date IS NOT NULL AND sale_platform IS NOT NULL))
);

INSERT INTO items_v2 (
  id, category, title, acquisition_cost, acquisition_date, status,
  listing_price, sale_price, sale_platform, sale_date, created_at,
  updated_at, tenant_id
)
SELECT
  id, category, title, acquisition_cost, acquisition_date, status,
  listing_price, sale_price, sale_platform, sale_date, created_at,
  updated_at, tenant_id
FROM items;

DROP TABLE items;
-- Other tables' triggers (book_details/clothing_details/etc.
-- *_tenant_matches_item_ins/upd, from 006_tenant_scoping.sql) reference
-- `items` in their trigger bodies. Modern SQLite's non-legacy ALTER TABLE
-- RENAME TO does a schema-wide recompile/validation of every trigger in the
-- database as part of the rename, which trips over those triggers mid-flight
-- ("no such table: main.items"). legacy_alter_table reverts RENAME TO to the
-- old, simple rename that skips that schema-wide pass; scoped to only this
-- one statement so it doesn't affect anything else in the transaction.
PRAGMA legacy_alter_table = ON;
ALTER TABLE items_v2 RENAME TO items;
PRAGMA legacy_alter_table = OFF;

CREATE TRIGGER items_category_immutable
BEFORE UPDATE ON items WHEN NEW.category != OLD.category
BEGIN SELECT RAISE(FAIL, 'category is immutable'); END;

CREATE INDEX idx_items_category         ON items(category);
CREATE INDEX idx_items_status           ON items(status);
CREATE INDEX idx_items_category_status  ON items(category, status);
CREATE INDEX idx_items_title            ON items(title COLLATE NOCASE);
CREATE INDEX idx_items_created_at       ON items(created_at);
CREATE INDEX idx_items_sale_date        ON items(sale_date) WHERE sale_date IS NOT NULL;
CREATE INDEX idx_items_tenant           ON items(tenant_id);
CREATE INDEX idx_items_tenant_status    ON items(tenant_id, status);
CREATE INDEX idx_items_tenant_category  ON items(tenant_id, category);

-- 2. electronics_details (additive, no rebuild needed -- this table
-- doesn't exist yet). No IF NOT EXISTS here either, per this migration's
-- convention (see items_v2 rebuild above) -- relies on transaction
-- atomicity alone, matching migration 013's convention.

CREATE TABLE electronics_details (
  item_id             TEXT    PRIMARY KEY REFERENCES items(id),
  tenant_id           TEXT    NOT NULL REFERENCES tenants(id)
                      DEFAULT '00000000-0000-4000-8000-000000000000',
  -- device_type has NO value CHECK -- validated at the app layer only,
  -- same tradeoff as SUPPORTED_PLATFORMS (see lib/constants.ts's existing
  -- comment on that choice). A future second device type (phone, tablet)
  -- needs zero migration for this column -- only new UI/validation.
  device_type         TEXT    NOT NULL DEFAULT 'laptop',
  brand               TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  processor           TEXT,
  ram_gb              INTEGER CHECK (ram_gb IS NULL OR ram_gb > 0),
  storage_gb          INTEGER CHECK (storage_gb IS NULL OR storage_gb > 0),
  screen_size_in      REAL    CHECK (screen_size_in IS NULL OR screen_size_in > 0),
  battery_health_pct  INTEGER CHECK (battery_health_pct IS NULL
                                      OR (battery_health_pct BETWEEN 0 AND 100)),
  battery_cycle_count INTEGER CHECK (battery_cycle_count IS NULL OR battery_cycle_count >= 0),
  condition           TEXT    NOT NULL
                      CHECK (condition IN ('New','Excellent','Good','Fair','For Parts'))
);

CREATE INDEX idx_electronics_details_tenant    ON electronics_details(tenant_id);
CREATE INDEX idx_electronics_details_condition ON electronics_details(condition);
CREATE INDEX idx_electronics_details_brand     ON electronics_details(brand COLLATE NOCASE);
CREATE INDEX idx_electronics_details_model     ON electronics_details(model COLLATE NOCASE);

CREATE TRIGGER electronics_details_tenant_matches_item_ins
BEFORE INSERT ON electronics_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN SELECT RAISE(FAIL, 'electronics_details.tenant_id must match items.tenant_id'); END;

CREATE TRIGGER electronics_details_tenant_matches_item_upd
BEFORE UPDATE ON electronics_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN SELECT RAISE(FAIL, 'electronics_details.tenant_id must match items.tenant_id'); END;

CREATE TRIGGER electronics_details_category_matches_item_ins
BEFORE INSERT ON electronics_details
WHEN (SELECT category FROM items WHERE id = NEW.item_id) != 'electronics'
BEGIN SELECT RAISE(FAIL, 'electronics_details.item_id must reference an electronics item'); END;

CREATE TRIGGER electronics_details_category_matches_item_upd
BEFORE UPDATE ON electronics_details
WHEN (SELECT category FROM items WHERE id = NEW.item_id) != 'electronics'
BEGIN SELECT RAISE(FAIL, 'electronics_details.item_id must reference an electronics item'); END;
