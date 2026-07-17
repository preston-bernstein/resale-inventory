-- Seeded vocabulary tables for clothing colors/materials/departments,
-- structurally identical to clothing_brands (migration 011) except:
--   * id drops the UUIDv4-version-nibble CHECK — the simplified
--     lower(hex(randomblob(16))) id shape (32 hex chars, no version nibble)
--     needs no shape constraint, eliminating unnecessary correctness risk.
--   * canonical_name gains an explicit <= 255 length cap matching the
--     app-layer validation these tables' data must satisfy.
--
-- DDL only in this migration — seeding/backfilling is handled by later
-- migrations that append to this same file.

CREATE TABLE clothing_colors (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0
                        AND length(canonical_name) <= 255),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);

CREATE TABLE clothing_materials (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0
                        AND length(canonical_name) <= 255),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);

CREATE TABLE clothing_departments (
  id             TEXT NOT NULL PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  canonical_name TEXT NOT NULL
                 CHECK (length(trim(canonical_name)) > 0
                        AND length(canonical_name) <= 255),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
                 CHECK (created_at LIKE '____-__-__%'),
  UNIQUE (tenant_id, canonical_name COLLATE NOCASE)
);

-- clothing_details currently has no plain tenant_id index (only composite
-- indexes that don't lead with it usefully for this query shape).
-- fetchFieldSuggestions's query (`WHERE tenant_id = ? GROUP BY {field}`) is
-- unindexed on this column today, and this feature triples that query's
-- traffic by wiring three new VocabCombobox instances into the same
-- suggestions endpoint — this is the right migration to add it in.
CREATE INDEX idx_clothing_details_tenant ON clothing_details(tenant_id);

-- NOTE: SQLite's grammar does not accept a column-alias list on a derived
-- table (`... ) AS v(name)`) the way PostgreSQL does — confirmed against
-- sqlite3 3.51.0 (`near "(": syntax error`). A `WITH v(name) AS (VALUES ...)`
-- CTE gets the same named column (SQLite CTEs DO accept a column-alias
-- list) without changing the seeded values, the CROSS JOIN shape, or any
-- apostrophe escaping below.
WITH v(name) AS (VALUES
  ('Black'),('White'),('Gray'),('Navy'),('Red'),('Blue'),('Green'),
  ('Yellow'),('Orange'),('Purple'),('Pink'),('Brown'),('Beige'),
  ('Multicolor')
)
INSERT OR IGNORE INTO clothing_colors (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

WITH v(name) AS (VALUES
  ('Cotton'),('Polyester'),('Wool'),('Denim'),('Leather'),('Silk'),
  ('Linen'),('Cashmere'),('Nylon'),('Spandex'),('Rayon'),('Fleece'),
  ('Suede'),('Canvas')
)
INSERT OR IGNORE INTO clothing_materials (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

-- WARNING: every apostrophe in a seed literal must be doubled (SQL escaping),
-- or the migration file fails to parse / truncates the string silently.
-- 'Men''s', 'Women''s', and 'Kids''' each carry one literal apostrophe:
--   'Kids''' breaks down as: opening quote, K-i-d-s, then '' (the doubled,
--   escaped apostrophe standing for the one literal ' in "Kids'"), then the
--   closing quote — three quote characters in a row at the end, not two,
--   not four. Verify each escaped literal by counting quote characters this
--   way, not by eye.
WITH v(name) AS (VALUES
  ('Men''s'),('Women''s'),('Kids'''),('Unisex'),('Baby')
)
INSERT OR IGNORE INTO clothing_departments (id, tenant_id, canonical_name)
SELECT lower(hex(randomblob(16))), t.id, v.name
FROM tenants t
CROSS JOIN v;

-- clothing_brands: existing table, existing CHECK (length(id) = 36 AND
-- substr(id, 15, 1) = '4') is unchanged, so this backfill (unlike the three
-- above) still needs the version-nibble UUIDv4-shaped expression to satisfy
-- it. 'Levi''s' is this list's one escaped apostrophe.
WITH v(name) AS (VALUES
  ('Nike'),('Adidas'),('Levi''s'),('Zara'),('H&M'),('Gap'),('Old Navy'),
  ('Ralph Lauren'),('Tommy Hilfiger'),('Calvin Klein'),('Coach'),
  ('Michael Kors'),('Patagonia'),('The North Face'),('Lululemon'),
  ('Under Armour'),('Vans'),('Converse'),('New Balance'),('Champion'),
  ('Carhartt'),('J.Crew'),('Banana Republic'),('American Eagle'),
  ('Free People')
)
INSERT OR IGNORE INTO clothing_brands (id, tenant_id, canonical_name)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) ||
        substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  t.id,
  v.name
FROM tenants t
CROSS JOIN v;
