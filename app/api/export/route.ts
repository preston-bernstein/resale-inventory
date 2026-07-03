import db from '@/lib/db';
import { centsToUSD } from '@/lib/money';
import Papa from 'papaparse';

const HEADERS = [
  'id', 'isbn', 'title', 'author', 'publisher', 'condition',
  'acquisition_cost_usd', 'acquisition_date', 'status',
  'listing_price_usd', 'platforms', 'sale_price_usd',
  'sale_platform', 'sale_date', 'gross_profit_usd', 'created_at', 'updated_at',
];

function sanitize(value: string): string {
  if (value && /^[=+\-@]/.test(value)) return '\t' + value;
  return value;
}

export async function GET() {
  try {
    const rows = db.prepare(`
      SELECT b.*,
        COALESCE(GROUP_CONCAT(bp.platform, ','), '') AS platforms_csv,
        CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END AS gross_profit_cents
      FROM books b
      LEFT JOIN book_platforms bp ON bp.book_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at
    `).all() as Record<string, unknown>[];

    const data = rows.map((row) => {
      const cells: string[] = [
        String(row.id ?? ''),
        String(row.isbn ?? ''),
        String(row.title ?? ''),
        String(row.author ?? ''),
        String(row.publisher ?? ''),
        String(row.condition ?? ''),
        centsToUSD(Number(row.acquisition_cost)),
        String(row.acquisition_date ?? ''),
        String(row.status ?? ''),
        row.listing_price != null ? centsToUSD(Number(row.listing_price)) : '',
        String(row.platforms_csv ?? ''),
        row.sale_price != null ? centsToUSD(Number(row.sale_price)) : '',
        String(row.sale_platform ?? ''),
        String(row.sale_date ?? ''),
        row.gross_profit_cents != null ? centsToUSD(Number(row.gross_profit_cents)) : '',
        String(row.created_at ?? ''),
        String(row.updated_at ?? ''),
      ];
      return cells.map(sanitize);
    });

    const csv = Papa.unparse({ fields: HEADERS, data });
    const date = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="inventory-${date}.csv"`,
      },
    });
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
}
