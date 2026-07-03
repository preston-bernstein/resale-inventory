import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { CONDITIONS as VALID_CONDITIONS } from '@/lib/constants';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const row = db
      .prepare(
        `SELECT b.*,
          COALESCE(GROUP_CONCAT(bp.platform, ','), '') as platforms_csv,
          CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END as gross_profit
         FROM books b
         LEFT JOIN book_platforms bp ON bp.book_id = b.id
         WHERE b.id = ?
         GROUP BY b.id`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    const platforms = row.platforms_csv ? String(row.platforms_csv).split(',') : [];

    const priceHistory = db
      .prepare('SELECT * FROM price_history WHERE book_id = ? ORDER BY changed_at')
      .all(id) as Array<Record<string, unknown>>;

    return NextResponse.json({
      ...row,
      platforms,
      platforms_csv: undefined,
      price_history: priceHistory,
    });
  } catch (err) {
    console.error('GET /api/books/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    // Fetch current book
    const current = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!current) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    const TERMINAL = ['Sold', 'Removed', 'Donated', 'Discarded'];
    if (TERMINAL.includes(current.status as string)) {
      return NextResponse.json({ error: 'Cannot update item with terminal status.' }, { status: 409 });
    }

    const invalidFields: string[] = [];

    const PRICE_REQUIRED = ['Listed', 'Sale Pending'];

    let newListingPrice: number | undefined;
    if ('listing_price' in body) {
      const lp = body.listing_price;
      if (lp === null) {
        if (PRICE_REQUIRED.includes(current.status as string)) {
          return NextResponse.json(
            {
              error:
                'Cannot clear listing_price while status is Listed or Sale Pending. Transition the item first.',
            },
            { status: 422 }
          );
        }
        newListingPrice = undefined; // allow clearing to null
      } else if (typeof lp !== 'number' || !Number.isInteger(lp) || lp < 0 || lp > 100_000_000) {
        invalidFields.push('listing_price');
      } else {
        newListingPrice = lp;
      }
    }

    let newCondition: string | undefined;
    if ('condition' in body) {
      const c = body.condition as string;
      if (!(VALID_CONDITIONS as readonly string[]).includes(c)) invalidFields.push('condition');
      else newCondition = c;
    }

    let newPlatforms: string[] | undefined;
    if ('platforms' in body) {
      if (!Array.isArray(body.platforms) || !(body.platforms as unknown[]).every(p => typeof p === 'string')) {
        invalidFields.push('platforms');
      } else {
        newPlatforms = body.platforms as string[];
      }
    }

    if (invalidFields.length > 0) {
      return NextResponse.json({ error: 'Validation failed.', fields: invalidFields }, { status: 422 });
    }
    if (!('listing_price' in body) && !('condition' in body) && !('platforms' in body)) {
      return NextResponse.json({ error: 'No fields to update.' }, { status: 422 });
    }

    // Run in transaction
    db.transaction(() => {
      const sets: string[] = ["updated_at = datetime('now')"];
      const vals: unknown[] = [];

      if ('listing_price' in body) {
        sets.push('listing_price = ?');
        const newPrice = body.listing_price === null ? null : newListingPrice!;
        vals.push(newPrice);

        // Insert price_history if changed
        const oldPrice = current.listing_price as number | null;
        if (oldPrice !== newPrice) {
          db.prepare(
            "INSERT INTO price_history (id, book_id, previous_price, new_price, changed_at) VALUES (?, ?, ?, ?, datetime('now'))"
          ).run(crypto.randomUUID(), id, oldPrice ?? 0, newPrice ?? 0);
        }
      }

      if (newCondition !== undefined) {
        sets.push('condition = ?');
        vals.push(newCondition);
      }

      db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

      if (newPlatforms !== undefined) {
        db.prepare('DELETE FROM book_platforms WHERE book_id = ?').run(id);
        const insertPlatform = db.prepare(
          "INSERT INTO book_platforms (id, book_id, platform, listed_at) VALUES (?, ?, ?, datetime('now'))"
        );
        for (const platform of newPlatforms) {
          insertPlatform.run(crypto.randomUUID(), id, platform);
        }
      }
    })();

    // Fetch updated row
    const updated = db
      .prepare(
        `SELECT b.*,
          COALESCE(GROUP_CONCAT(bp.platform, ','), '') as platforms_csv,
          CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END as gross_profit
         FROM books b
         LEFT JOIN book_platforms bp ON bp.book_id = b.id
         WHERE b.id = ?
         GROUP BY b.id`,
      )
      .get(id) as Record<string, unknown>;

    return NextResponse.json({
      ...updated,
      platforms: updated.platforms_csv ? String(updated.platforms_csv).split(',') : [],
      platforms_csv: undefined,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_CHECK') {
      console.error('PATCH /api/books/[id] CHECK constraint:', err);
      return NextResponse.json({ error: 'Validation failed.' }, { status: 422 });
    }
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      console.error('PATCH /api/books/[id] UNIQUE constraint:', err);
      return NextResponse.json({ error: 'Conflicts with an existing record.' }, { status: 409 });
    }
    console.error('PATCH /api/books/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
