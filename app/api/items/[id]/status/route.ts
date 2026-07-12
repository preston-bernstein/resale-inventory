import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertTransitionAllowed, BookStatus, ALLOWED_TRANSITIONS } from '@/lib/transitions';
import { DATE_RE } from '@/lib/constants';

const VALID_STATUSES = new Set<string>(Object.keys(ALLOWED_TRANSITIONS));

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const { status: toStatus, sale_price, sale_platform, sale_date } = body as Record<string, unknown>;

  if (typeof toStatus !== 'string' || !VALID_STATUSES.has(toStatus)) {
    return NextResponse.json({ error: 'Invalid status value.' }, { status: 422 });
  }

  if (toStatus === 'Sold') {
    const missingOrInvalid =
      typeof sale_price !== 'number' || !Number.isInteger(sale_price) || sale_price < 0 || sale_price > 100_000_000 ||
      typeof sale_platform !== 'string' || sale_platform.trim() === '' ||
      typeof sale_date !== 'string' || !DATE_RE.test(sale_date);
    if (missingOrInvalid) {
      return NextResponse.json({ error: 'sale_price, sale_platform, and sale_date are required when transitioning to Sold.' }, { status: 422 });
    }
  }

  let notFound = false;
  let transitionError: string | null = null;
  let missingListingPrice = false;

  try {
    const result = db.transaction(() => {
      const item = db.prepare('SELECT id, status, listing_price FROM items WHERE id = ?').get(id) as { id: string; status: string; listing_price: number | null } | undefined;
      if (!item) { notFound = true; return null; }
      const fromStatus = item.status as BookStatus;
      try {
        assertTransitionAllowed(fromStatus, toStatus as BookStatus);
      } catch (err) {
        transitionError = (err as Error).message;
        return null;
      }
      if ((toStatus === 'Listed' || toStatus === 'Sale Pending') && item.listing_price === null) {
        missingListingPrice = true;
        return null;
      }
      if (toStatus === 'Sold') {
        db.prepare(`UPDATE items SET status = ?, sale_price = ?, sale_platform = ?, sale_date = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(toStatus, sale_price as number, (sale_platform as string).trim(), sale_date, id);
      } else {
        db.prepare(`UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(toStatus, id);
      }
      const row = db.prepare(
        `SELECT i.*, COALESCE(GROUP_CONCAT(ip.platform, ','), '') as platforms_csv,
           CASE WHEN i.status = 'Sold' THEN (i.sale_price - i.acquisition_cost) ELSE NULL END as gross_profit
         FROM items i LEFT JOIN item_platforms ip ON ip.item_id = i.id WHERE i.id = ? GROUP BY i.id`
      ).get(id) as (Record<string, unknown> & { platforms_csv: string }) | undefined;
      return row;
    })();

    if (notFound) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    if (transitionError) return NextResponse.json({ error: transitionError }, { status: 422 });
    if (missingListingPrice) return NextResponse.json({ error: 'Cannot list an item without a listing_price. Set a price first via PATCH.' }, { status: 422 });
    if (!result) {
      // Every known reason `result` can be null/undefined is handled above;
      // reaching here means the post-UPDATE SELECT unexpectedly found no
      // row (e.g. deleted between the UPDATE and the SELECT). Treat as a
      // genuine server error rather than asserting past it.
      console.error('POST /api/items/[id]/status: transaction returned no row and no known failure reason');
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
    }

    const platforms = result.platforms_csv ? String(result.platforms_csv).split(',') : [];
    return NextResponse.json({ ...result, platforms, platforms_csv: undefined });
  } catch (err) {
    console.error('POST /api/items/[id]/status error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
