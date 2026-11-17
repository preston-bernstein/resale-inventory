import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertTransitionAllowed, type BookStatus, ALLOWED_TRANSITIONS } from '@/lib/transitions';
import { DATE_RE } from '@/lib/constants';
import { requireTenant } from '@/lib/apiRequest';

const VALID_STATUSES = new Set<string>(Object.keys(ALLOWED_TRANSITIONS));

interface SaleFields {
  sale_price: unknown;
  sale_platform: unknown;
  sale_date: unknown;
}

type ItemWithPlatforms = Record<string, unknown> & { platforms_csv: string };

type StatusChangeOutcome =
  | { kind: 'changed'; row: ItemWithPlatforms | undefined }
  | { kind: 'not_found' }
  | { kind: 'transition_error'; message: string }
  | { kind: 'missing_listing_price' };

function hasValidSaleFields({ sale_price, sale_platform, sale_date }: SaleFields): boolean {
  const priceValid =
    typeof sale_price === 'number' &&
    Number.isInteger(sale_price) &&
    sale_price >= 0 &&
    sale_price <= 100_000_000;
  const platformValid = typeof sale_platform === 'string' && sale_platform.trim() !== '';
  const dateValid = typeof sale_date === 'string' && DATE_RE.test(sale_date);
  return priceValid && platformValid && dateValid;
}

/** The message explaining why the transition is not allowed, or null when it is. */
function transitionErrorMessage(from: BookStatus, to: BookStatus): string | null {
  try {
    assertTransitionAllowed(from, to);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function writeStatus(id: string, toStatus: string, sale: SaleFields): void {
  if (toStatus !== 'Sold') {
    db.prepare(`UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
      toStatus,
      id,
    );
    return;
  }
  db.prepare(
    `UPDATE items SET status = ?, sale_price = ?, sale_platform = ?, sale_date = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(toStatus, sale.sale_price as number, (sale.sale_platform as string).trim(), sale.sale_date, id);
}

function fetchItemWithPlatforms(id: string): ItemWithPlatforms | undefined {
  return db
    .prepare(
      `SELECT i.*, COALESCE(GROUP_CONCAT(ip.platform, ','), '') as platforms_csv,
           CASE WHEN i.status = 'Sold' THEN (i.sale_price - i.acquisition_cost) ELSE NULL END as gross_profit
         FROM items i LEFT JOIN item_platforms ip ON ip.item_id = i.id WHERE i.id = ? GROUP BY i.id`,
    )
    .get(id) as ItemWithPlatforms | undefined;
}

/** Validate the transition and write it, all in one transaction. */
function changeStatus(
  tenantId: string,
  id: string,
  toStatus: string,
  sale: SaleFields,
): StatusChangeOutcome {
  return db.transaction((): StatusChangeOutcome => {
    const item = db
      .prepare('SELECT id, status, listing_price FROM items WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as { id: string; status: string; listing_price: number | null } | undefined;
    if (!item) return { kind: 'not_found' };

    const message = transitionErrorMessage(item.status as BookStatus, toStatus as BookStatus);
    if (message) return { kind: 'transition_error', message };

    const needsPrice = toStatus === 'Listed' || toStatus === 'Sale Pending';
    if (needsPrice && item.listing_price === null) return { kind: 'missing_listing_price' };

    writeStatus(id, toStatus, sale);
    return { kind: 'changed', row: fetchItemWithPlatforms(id) };
  })();
}

function statusChangeResponse(outcome: StatusChangeOutcome): NextResponse {
  switch (outcome.kind) {
    case 'not_found':
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    case 'transition_error':
      return NextResponse.json({ error: outcome.message }, { status: 422 });
    case 'missing_listing_price':
      return NextResponse.json(
        { error: 'Cannot list an item without a listing_price. Set a price first via PATCH.' },
        { status: 422 },
      );
    case 'changed': {
      const result = outcome.row;
      if (!result) {
        // Every known failure reason is handled above; reaching here means
        // the post-UPDATE SELECT unexpectedly found no row (e.g. deleted
        // between the UPDATE and the SELECT). Treat as a genuine server
        // error rather than asserting past it.
        console.error('POST /api/items/[id]/status: transaction returned no row and no known failure reason');
        return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
      }
      const platforms = result.platforms_csv ? String(result.platforms_csv).split(',') : [];
      return NextResponse.json({ ...result, platforms, platforms_csv: undefined });
    }
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const tenant = requireTenant(req);
  if (tenant instanceof NextResponse) return tenant;

  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  const { status: toStatus, sale_price, sale_platform, sale_date } = body as Record<string, unknown>;
  const sale: SaleFields = { sale_price, sale_platform, sale_date };

  if (typeof toStatus !== 'string' || !VALID_STATUSES.has(toStatus)) {
    return NextResponse.json({ error: 'Invalid status value.' }, { status: 422 });
  }

  if (toStatus === 'Sold' && !hasValidSaleFields(sale)) {
    return NextResponse.json({ error: 'sale_price, sale_platform, and sale_date are required when transitioning to Sold.' }, { status: 422 });
  }

  try {
    return statusChangeResponse(changeStatus(tenant.tenantId, id, toStatus, sale));
  } catch (err) {
    console.error('POST /api/items/[id]/status error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
