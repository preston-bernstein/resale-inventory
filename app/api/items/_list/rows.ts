import db from '@/lib/db';
import { buildItemFilters } from './filters';
import type { ParsedListQuery } from './query';

/** The detail columns each category's table contributes, under its join alias. */
const DETAIL_TABLES = {
  book: {
    alias: 'bd',
    fields: ['isbn', 'author', 'publisher', 'condition'],
  },
  clothing: {
    alias: 'cd',
    fields: [
      'brand',
      'size_label',
      'color',
      'material',
      'gender_department',
      'weight_oz',
      'pit_to_pit_in',
      'length_in',
      'sleeve_length_in',
      'waist_in',
      'rise_in',
      'inseam_in',
      'leg_opening_in',
      'hip_in',
      'condition',
    ],
  },
  electronics: {
    alias: 'ed',
    fields: [
      'device_type',
      'brand',
      'model',
      'processor',
      'ram_gb',
      'storage_gb',
      'screen_size_in',
      'battery_health_pct',
      'battery_cycle_count',
      'condition',
    ],
  },
} as const;

type DetailCategory = keyof typeof DETAIL_TABLES;

const DETAIL_SELECT = Object.values(DETAIL_TABLES)
  .flatMap(({ alias, fields }) => fields.map((field) => `${alias}.${field} as ${alias}_${field}`))
  .join(',\n            ');

const FROM_JOIN = `FROM items i
       LEFT JOIN book_details bd ON bd.item_id = i.id
       LEFT JOIN clothing_details cd ON cd.item_id = i.id
       LEFT JOIN electronics_details ed ON ed.item_id = i.id`;

/** Map one joined items + detail-table row to the API response shape. */
function mapItemRow(row: Record<string, unknown>): Record<string, unknown> {
  const base = {
    id: row.id,
    category: row.category,
    title: row.title,
    status: row.status,
    acquisition_cost: row.acquisition_cost,
    acquisition_date: row.acquisition_date,
    listing_price: row.listing_price,
    sale_price: row.sale_price,
    sale_date: row.sale_date,
    sale_platform: row.sale_platform,
    created_at: row.created_at,
    updated_at: row.updated_at,
    platforms: row.platforms_csv ? String(row.platforms_csv).split(',') : [],
    cover_photo_id: row.cover_photo_id ?? null,
  };

  // Any category other than book or electronics is read as clothing.
  const category: DetailCategory =
    row.category === 'book' || row.category === 'electronics' ? row.category : 'clothing';
  const { alias, fields } = DETAIL_TABLES[category];
  const details = Object.fromEntries(fields.map((field) => [field, row[`${alias}_${field}`]]));

  return { ...base, details };
}

/** Run the filtered, paginated item search for one tenant. */
export function searchItems(
  tenantId: string,
  parsed: ParsedListQuery,
): { items: Array<Record<string, unknown>>; total: number } {
  const { filterClauses, filterParams } = buildItemFilters(tenantId, parsed);
  const where = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) as count ${FROM_JOIN} ${where}`).get(...filterParams) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT i.*,
            ${DETAIL_SELECT},
            COALESCE(GROUP_CONCAT(ip.platform, ','), '') as platforms_csv,
            (SELECT id FROM item_photos WHERE item_id = i.id ORDER BY sort_order LIMIT 1) as cover_photo_id
         ${FROM_JOIN}
         LEFT JOIN item_platforms ip ON ip.item_id = i.id
         ${where}
         GROUP BY i.id
         ORDER BY i.created_at DESC
         LIMIT ? OFFSET ?`,
    )
    .all(...filterParams, parsed.limit, parsed.offset) as Array<Record<string, unknown>>;

  return { items: rows.map(mapItemRow), total };
}
