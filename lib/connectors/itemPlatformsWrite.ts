import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';

/**
 * Upsert an item_platforms row recording that a listing was created for an
 * item on a marketplace platform, keyed on the table's existing
 * UNIQUE(item_id, platform) constraint (003_multi_category.sql). Called by
 * connector code the moment a marketplace API/browser-bot confirms a
 * listing now exists.
 *
 * First call for an (item_id, platform) pair inserts a fresh row with
 * listed_at = now. A later call for the SAME pair (e.g. a retried
 * listing-creation call, or a relist that reuses the same platform slot)
 * does NOT insert a duplicate row -- ON CONFLICT(item_id, platform) updates
 * external_listing_id on the existing row instead, matching the constraint's
 * intent that at most one item_platforms row exists per (item, platform).
 * listed_at is deliberately left untouched on conflict -- it records when
 * the item was FIRST listed on this platform, not the most recent write.
 *
 * tenant_id is set from the explicit tenantId parameter, never inferred --
 * the item_platforms_tenant_matches_item_ins/upd triggers
 * (006_tenant_scoping.sql) enforce at the DB layer that it matches the
 * parent item's tenant_id, so a caller passing the wrong tenantId fails
 * loudly with a SQLite constraint error rather than silently writing a
 * mismatched row. On the conflict/update path, tenant_id is left alone
 * (not part of the SET clause) since the existing row's tenant_id already
 * matches its parent item and never needs to change.
 *
 * external_listing_id is also constrained by idx_item_platforms_external_listing
 * (009_item_platforms_external_id.sql) -- a UNIQUE index on
 * (platform, external_listing_id) for non-NULL values -- so passing an
 * external_listing_id already claimed by a different item on the same
 * platform fails loudly with a SQLite constraint error rather than silently
 * overwriting the other item's row.
 */
export function recordListingCreated(
  tenantId: string,
  itemId: string,
  platform: string,
  externalListingId: string,
): void {
  db.prepare(
    `INSERT INTO item_platforms (id, item_id, tenant_id, platform, external_listing_id, listed_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(item_id, platform) DO UPDATE SET external_listing_id = excluded.external_listing_id`,
  ).run(uuidv4(), itemId, tenantId, platform, externalListingId);
}
