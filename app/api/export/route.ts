import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { centsToUSD } from '@/lib/money';
import { requireTenant } from '@/lib/apiRequest';
import Papa from 'papaparse';

const HEADERS = [
  'id', 'category', 'title', 'isbn', 'author', 'publisher',
  'brand', 'size_label', 'color', 'material', 'gender_department',
  'weight_oz', 'pit_to_pit_in', 'length_in', 'sleeve_length_in',
  'waist_in', 'rise_in', 'inseam_in', 'leg_opening_in', 'hip_in',
  'model', 'processor', 'ram_gb', 'storage_gb', 'screen_size_in',
  'battery_health_pct', 'battery_cycle_count',
  'condition', 'acquisition_cost_usd', 'acquisition_date', 'status',
  'listing_price_usd', 'platforms', 'sale_price_usd', 'sale_platform',
  'sale_date', 'gross_profit_usd', 'created_at', 'updated_at',
];

type ExportRow = Record<string, unknown>;

function sanitize(value: string): string {
  if (value && /^[=+\-@]/.test(value)) return '\t' + value;
  return value;
}

function str(value: unknown): string {
  return String(value ?? '');
}

function moneyCell(value: unknown): string {
  return value != null ? centsToUSD(Number(value)) : '';
}

/** ISBN / author / publisher — populated only for book rows. */
function bookFieldsOrBlank(row: ExportRow, isBook: boolean): string[] {
  if (!isBook) return ['', '', ''];
  return [str(row.isbn), str(row.author), str(row.publisher)];
}

/** "brand" is sourced from whichever satellite table matches the row's category. */
function brandCell(row: ExportRow, isClothing: boolean, isElectronics: boolean): string {
  if (isClothing) return str(row.clothing_brand);
  if (isElectronics) return str(row.electronics_brand);
  return '';
}

/** Clothing-detail columns (excluding brand, which is a shared cell) — populated only for clothing rows. */
function clothingFieldsOrBlank(row: ExportRow, isClothing: boolean): string[] {
  if (!isClothing) return Array(13).fill('');
  return [
    str(row.size_label),
    str(row.color),
    str(row.material),
    str(row.gender_department),
    str(row.weight_oz),
    str(row.pit_to_pit_in),
    str(row.length_in),
    str(row.sleeve_length_in),
    str(row.waist_in),
    str(row.rise_in),
    str(row.inseam_in),
    str(row.leg_opening_in),
    str(row.hip_in),
  ];
}

/** Electronics-detail columns (excluding brand/condition, which are shared cells) — populated only for electronics rows. */
function electronicsFieldsOrBlank(row: ExportRow, isElectronics: boolean): string[] {
  if (!isElectronics) return Array(7).fill('');
  return [
    str(row.model),
    str(row.processor),
    str(row.ram_gb),
    str(row.storage_gb),
    str(row.screen_size_in),
    str(row.battery_health_pct),
    str(row.battery_cycle_count),
  ];
}

/** "condition" is sourced from whichever satellite table matches the row's category. */
function conditionCell(row: ExportRow, isBook: boolean, isClothing: boolean, isElectronics: boolean): string {
  if (isBook) return str(row.book_condition);
  if (isClothing) return str(row.clothing_condition);
  if (isElectronics) return str(row.electronics_condition);
  return '';
}

/** Sale-related columns, all blank until the item is Sold / listed / has a sale price. */
function saleFields(row: ExportRow): string[] {
  return [
    moneyCell(row.listing_price),
    str(row.platforms_csv),
    moneyCell(row.sale_price),
    str(row.sale_platform),
    str(row.sale_date),
    moneyCell(row.gross_profit_cents),
  ];
}

/** Maps one joined DB row to its full, sanitized CSV cell array (column order matches HEADERS). */
function rowToCsvRecord(row: ExportRow): string[] {
  const isBook = row.category === 'book';
  const isClothing = row.category === 'clothing';
  const isElectronics = row.category === 'electronics';

  const cells: string[] = [
    str(row.id),
    str(row.category),
    str(row.title),
    ...bookFieldsOrBlank(row, isBook),
    brandCell(row, isClothing, isElectronics),
    ...clothingFieldsOrBlank(row, isClothing),
    ...electronicsFieldsOrBlank(row, isElectronics),
    conditionCell(row, isBook, isClothing, isElectronics),
    moneyCell(row.acquisition_cost),
    str(row.acquisition_date),
    str(row.status),
    ...saleFields(row),
    str(row.created_at),
    str(row.updated_at),
  ];

  return cells.map(sanitize);
}

/**
 * `WHERE i.tenant_id = ?` is unconditional -- this handler has no other
 * filters (unlike app/api/items/route.ts's GET), so there's no "no filters
 * supplied" branch to get wrong, but the clause must still always be present
 * or every tenant's inventory ends up in every other tenant's export.
 */
function fetchExportRows(tenantId: string): ExportRow[] {
  return db.prepare(`
    SELECT i.*,
      bd.isbn AS isbn,
      bd.author AS author,
      bd.publisher AS publisher,
      bd.condition AS book_condition,
      cd.brand AS clothing_brand,
      cd.size_label AS size_label,
      cd.color AS color,
      cd.material AS material,
      cd.gender_department AS gender_department,
      cd.weight_oz AS weight_oz,
      cd.pit_to_pit_in AS pit_to_pit_in,
      cd.length_in AS length_in,
      cd.sleeve_length_in AS sleeve_length_in,
      cd.waist_in AS waist_in,
      cd.rise_in AS rise_in,
      cd.inseam_in AS inseam_in,
      cd.leg_opening_in AS leg_opening_in,
      cd.hip_in AS hip_in,
      cd.condition AS clothing_condition,
      ed.brand AS electronics_brand,
      ed.model AS model,
      ed.processor AS processor,
      ed.ram_gb AS ram_gb,
      ed.storage_gb AS storage_gb,
      ed.screen_size_in AS screen_size_in,
      ed.battery_health_pct AS battery_health_pct,
      ed.battery_cycle_count AS battery_cycle_count,
      ed.condition AS electronics_condition,
      COALESCE(GROUP_CONCAT(ip.platform, ','), '') AS platforms_csv,
      CASE WHEN i.status = 'Sold' THEN (i.sale_price - i.acquisition_cost) ELSE NULL END AS gross_profit_cents
    FROM items i
    LEFT JOIN book_details bd ON bd.item_id = i.id
    LEFT JOIN clothing_details cd ON cd.item_id = i.id
    LEFT JOIN electronics_details ed ON ed.item_id = i.id
    LEFT JOIN item_platforms ip ON ip.item_id = i.id
    WHERE i.tenant_id = ?
    GROUP BY i.id
    ORDER BY i.created_at
  `).all(tenantId) as ExportRow[];
}

function buildCsvResponse(rows: ExportRow[]): Response {
  const data = rows.map(rowToCsvRecord);
  const csv = Papa.unparse({ fields: HEADERS, data });
  const date = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const rows = fetchExportRows(tenant.tenantId);
    return buildCsvResponse(rows);
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
}
