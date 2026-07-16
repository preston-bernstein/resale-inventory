ALTER TABLE item_platforms ADD COLUMN external_listing_id TEXT
  CHECK (external_listing_id IS NULL OR length(trim(external_listing_id)) BETWEEN 1 AND 255);

CREATE UNIQUE INDEX idx_item_platforms_external_listing
  ON item_platforms(platform, external_listing_id)
  WHERE external_listing_id IS NOT NULL;
