import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertTransitionAllowed, BookStatus, ALLOWED_TRANSITIONS } from '@/lib/transitions';

const VALID_STATUSES = new Set<string>(Object.keys(ALLOWED_TRANSITIONS));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { status: toStatus, sale_price, sale_platform, sale_date } =
    body as Record<string, unknown>;

  // Validate toStatus is a known BookStatus
  if (typeof toStatus !== 'string' || !VALID_STATUSES.has(toStatus)) {
    return NextResponse.json({ error: 'Invalid status value.' }, { status: 422 });
  }

  // Validate sale fields when transitioning to Sold
  if (toStatus === 'Sold') {
    const missingOrInvalid =
      typeof sale_price !== 'number' ||
      !Number.isInteger(sale_price) ||
      sale_price < 0 ||
      sale_price > 100_000_000 ||
      typeof sale_platform !== 'string' ||
      sale_platform.trim() === '' ||
      typeof sale_date !== 'string' ||
      !DATE_RE.test(sale_date);

    if (missingOrInvalid) {
      return NextResponse.json(
        { error: 'sale_price, sale_platform, and sale_date are required when transitioning to Sold.' },
        { status: 422 }
      );
    }
  }

  let notFound = false;
  let transitionError: string | null = null;

  try {
    const result = db.transaction(() => {
      const book = db
        .prepare('SELECT id, status FROM books WHERE id = ?')
        .get(id) as { id: string; status: string } | undefined;

      if (!book) {
        notFound = true;
        return null;
      }

      const fromStatus = book.status as BookStatus;

      try {
        assertTransitionAllowed(fromStatus, toStatus as BookStatus);
      } catch (err) {
        transitionError = (err as Error).message;
        return null;
      }

      if (toStatus === 'Sold') {
        db.prepare(
          `UPDATE books
             SET status = ?, sale_price = ?, sale_platform = ?, sale_date = ?,
                 updated_at = datetime('now')
           WHERE id = ?`
        ).run(toStatus, sale_price as number, (sale_platform as string).trim(), sale_date, id);
      } else {
        db.prepare(
          `UPDATE books SET status = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(toStatus, id);
      }

      const row = db
        .prepare(
          `SELECT b.*, COALESCE(GROUP_CONCAT(bp.platform, ','), '') as platforms_csv
             FROM books b
             LEFT JOIN book_platforms bp ON bp.book_id = b.id
            WHERE b.id = ?
            GROUP BY b.id`
        )
        .get(id) as (Record<string, unknown> & { platforms_csv: string }) | undefined;

      return row ?? null;
    })();

    if (notFound) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    if (transitionError) {
      return NextResponse.json({ error: transitionError }, { status: 422 });
    }

    if (!result) {
      return NextResponse.json({ error: 'Unexpected error.' }, { status: 500 });
    }

    const { platforms_csv, ...rest } = result;
    return NextResponse.json({
      ...rest,
      platforms: platforms_csv ? platforms_csv.split(',') : [],
    });
  } catch (err) {
    console.error('[POST /api/books/[id]/status] DB error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
