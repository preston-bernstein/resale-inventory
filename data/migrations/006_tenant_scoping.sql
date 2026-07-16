-- Additive per SQLite semantics: ADD COLUMN with a constant DEFAULT does not
-- rebuild the table. Backfills every pre-existing row onto the default tenant
-- (FR6, FR7) without touching any other column or existing CHECK constraint.
ALTER TABLE items            ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE book_details      ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE clothing_details  ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE item_platforms    ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE item_photos       ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';
ALTER TABLE price_history     ADD COLUMN tenant_id TEXT NOT NULL REFERENCES tenants(id)
                              DEFAULT '00000000-0000-4000-8000-000000000000';

CREATE INDEX idx_items_tenant        ON items(tenant_id);
CREATE INDEX idx_items_tenant_status ON items(tenant_id, status);
-- Satellite tenant_id columns exist to satisfy FR6's literal per-table
-- requirement and give defense-in-depth filtering; no extra index is added
-- on them since every existing query path reaches them via item_id, already
-- indexed. Application code sets each satellite row's tenant_id equal to its
-- parent item's tenant_id at insert time (see Integration points).

-- The six ALTER TABLE statements above run inside the same single
-- db.transaction() every versioned migration file in lib/db.ts's runner
-- already gets automatically -- this is not a new mechanism, just a
-- confirmation that the existing atomic-migration guarantee (all-or-nothing
-- per file) already covers a mid-file crash partway through this migration.

-- A CHECK constraint can't reference another table in SQLite, so a trigger
-- backs up the "satellite tenant_id must match parent item's tenant_id"
-- invariant at the DB level -- mirrors the items_category_immutable trigger
-- precedent in 003_multi_category.sql. Without this, a drift bug (e.g. a
-- satellite insert that forgets to copy the parent's tenant_id) silently
-- makes that row invisible to its owning tenant (fails the WHERE tenant_id
-- = ? filter) instead of erroring loudly -- this makes FR9's "isolation
-- must not depend solely on application code" hold at the DB level too, not
-- just via explicit tenantId parameters threaded through lib/*.
CREATE TRIGGER book_details_tenant_matches_item_ins
BEFORE INSERT ON book_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'book_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER book_details_tenant_matches_item_upd
BEFORE UPDATE ON book_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'book_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER clothing_details_tenant_matches_item_ins
BEFORE INSERT ON clothing_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'clothing_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER clothing_details_tenant_matches_item_upd
BEFORE UPDATE ON clothing_details
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'clothing_details.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_platforms_tenant_matches_item_ins
BEFORE INSERT ON item_platforms
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_platforms.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_platforms_tenant_matches_item_upd
BEFORE UPDATE ON item_platforms
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_platforms.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_photos_tenant_matches_item_ins
BEFORE INSERT ON item_photos
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_photos.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER item_photos_tenant_matches_item_upd
BEFORE UPDATE ON item_photos
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'item_photos.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER price_history_tenant_matches_item_ins
BEFORE INSERT ON price_history
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'price_history.tenant_id must match items.tenant_id');
END;

CREATE TRIGGER price_history_tenant_matches_item_upd
BEFORE UPDATE ON price_history
WHEN NEW.tenant_id != (SELECT tenant_id FROM items WHERE id = NEW.item_id)
BEGIN
  SELECT RAISE(FAIL, 'price_history.tenant_id must match items.tenant_id');
END;
