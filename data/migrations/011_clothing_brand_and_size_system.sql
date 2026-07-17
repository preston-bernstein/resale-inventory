-- Canonical brand list, scoped per-tenant like every other satellite table
-- (idx_items_tenant precedent) — no cross-tenant sharing concept exists
-- per requirements' out-of-scope note, so per-tenant storage is the
-- correct model, not a compromise.
--
-- Alias support (e.g. "TNF" -> "The North Face") is explicitly deferred
-- per requirements.md's updated Out-of-scope section — nothing in this
-- pass ever writes an alias row, so a clothing_brand_aliases table would
-- be schema for a feature that isn't wired up. COLLATE NOCASE canonical
-- matching already solves the actual casing problem from the requirements
-- ("Nike"/"nike"/"NIKE" collapse to one row); it does not solve synonym
-- matching, which is out of scope here.
CREATE TABLE clothing_brands (
  id             TEXT NOT NULL PRIMARY KEY
                 CHECK (length(id) = 36 AND substr(id, 15, 1) = '4'),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);
-- No separate idx_clothing_brands_tenant index: the UNIQUE constraint above
-- already creates a tenant_id-leading index that serves the same queries.

-- Additive, nullable, no DEFAULT needed (NULL means "no closed vocabulary
-- selected" — the exact behavior every pre-existing row already has).
-- ADD COLUMN with no DEFAULT + no NOT NULL does not rebuild the table
-- (same reasoning as 006's tenant_id ADD COLUMNs).
--
-- No DB-level CHECK constraint on the allowed values: SQLite can't ALTER a
-- CHECK constraint in place (it requires a full table rebuild), and the
-- plan already treats the size vocabulary itself as "cheap to widen later"
-- via a plain array/regex in lib/clothing.ts rather than a migration-locked
-- enum — a DB CHECK here would be inconsistent with that same reasoning.
-- Validation is app-layer only, via validateSizeSystem in lib/clothing.ts.
ALTER TABLE clothing_details ADD COLUMN size_system TEXT;
