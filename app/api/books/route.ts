import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { normalizeISBN, lookupISBN } from '@/lib/isbn';
import { CONDITIONS as VALID_CONDITIONS, type Condition, DATE_RE } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    // --- ISBN normalisation + lookup ---
    let normalizedIsbn: string | null = null;
    let lookedUp: { title: string; author: string; publisher: string } | null = null;

    if (body.isbn !== undefined && body.isbn !== null && body.isbn !== '') {
      const rawIsbn = String(body.isbn);
      try {
        normalizedIsbn = normalizeISBN(rawIsbn);
      } catch {
        return NextResponse.json({ error: 'Invalid ISBN format.' }, { status: 422 });
      }
      // Lookup is best-effort here: only a 'found' record supplies defaults;
      // any failure class (not-found / unavailable) leaves manual fields to
      // fill in, so a provider outage never blocks creation (FR3 / AC11).
      const lookup = await lookupISBN(normalizedIsbn);
      if (lookup.status === 'found') {
        lookedUp = {
          title: lookup.title,
          author: lookup.author,
          publisher: lookup.publisher,
        };
      }
    }

    // Merge: lookup provides defaults; body fields override
    const title =
      typeof body.title === 'string' && body.title.trim() !== ''
        ? body.title.trim()
        : lookedUp?.title?.trim() ?? '';

    const author =
      typeof body.author === 'string' && body.author.trim() !== ''
        ? body.author.trim()
        : lookedUp?.author?.trim() ?? '';

    const publisher =
      typeof body.publisher === 'string' && body.publisher.trim() !== ''
        ? body.publisher.trim()
        : lookedUp?.publisher?.trim() ?? '';

    // --- Validation ---
    const invalidFields: string[] = [];

    if (!title) invalidFields.push('title');
    if (!author) invalidFields.push('author');

    const condition = body.condition as string | undefined;
    if (!condition || !(VALID_CONDITIONS as readonly string[]).includes(condition)) {
      invalidFields.push('condition');
    }

    const acquisition_cost = body.acquisition_cost;
    if (
      typeof acquisition_cost !== 'number' ||
      !Number.isInteger(acquisition_cost) ||
      acquisition_cost < 0 ||
      acquisition_cost > 100_000_000
    ) {
      invalidFields.push('acquisition_cost');
    }

    const acquisition_date = body.acquisition_date;
    if (typeof acquisition_date !== 'string' || !DATE_RE.test(acquisition_date)) {
      invalidFields.push('acquisition_date');
    }

    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: 'Validation failed.', fields: invalidFields },
        { status: 422 },
      );
    }

    // --- Duplicate ISBN check ---
    if (normalizedIsbn !== null) {
      const existing = db
        .prepare('SELECT id FROM books WHERE isbn = ?')
        .get(normalizedIsbn);
      if (existing) {
        return NextResponse.json({ error: 'ISBN already exists.' }, { status: 409 });
      }
    }

    // --- Insert ---
    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO books
         (id, isbn, title, author, publisher, condition, acquisition_cost, acquisition_date,
          status, listing_price, sale_price, sale_platform, sale_date, created_at, updated_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, 'Unlisted', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      normalizedIsbn,
      title,
      author,
      publisher ?? null,
      condition as Condition,
      acquisition_cost as number,
      acquisition_date as string,
      now,
      now,
    );

    // --- Fetch and return ---
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;

    return NextResponse.json({ ...row, platforms: [] }, { status: 201 });
  } catch (err) {
    console.error('POST /api/books error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0);
    const limit = parseInt(searchParams.get('limit') ?? '25', 10) || 25;
    if (limit < 1 || limit > 200) {
      return NextResponse.json({ error: 'limit must be 1–200.' }, { status: 400 });
    }
    const offset = page * limit;

    const q = searchParams.get('q') ?? '';
    if (q.length > 200) {
      return NextResponse.json({ error: 'q exceeds 200 characters.' }, { status: 400 });
    }
    const isbn = searchParams.get('isbn') ?? '';
    const title = searchParams.get('title') ?? '';
    const author = searchParams.get('author') ?? '';
    const condition = searchParams.get('condition') ?? '';
    const status = searchParams.get('status') ?? '';

    const filterClauses: string[] = [];
    const filterParams: unknown[] = [];

    if (q) {
      filterClauses.push('(b.title LIKE ? OR b.author LIKE ?)');
      filterParams.push(`%${q}%`, `%${q}%`);
    }
    if (isbn) {
      filterClauses.push('b.isbn = ?');
      filterParams.push(isbn);
    }
    if (title) {
      filterClauses.push('b.title LIKE ?');
      filterParams.push(`%${title}%`);
    }
    if (author) {
      filterClauses.push('b.author LIKE ?');
      filterParams.push(`%${author}%`);
    }
    if (condition) {
      filterClauses.push('b.condition = ?');
      filterParams.push(condition);
    }
    if (status) {
      filterClauses.push('b.status = ?');
      filterParams.push(status);
    }

    const where = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';

    const total = (
      db.prepare(`SELECT COUNT(*) as count FROM books b ${where}`).get(...filterParams) as { count: number }
    ).count;

    const items = db
      .prepare(
        `SELECT b.*,
          COALESCE(GROUP_CONCAT(bp.platform, ','), '') as platforms_csv,
          CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END as gross_profit
         FROM books b
         LEFT JOIN book_platforms bp ON bp.book_id = b.id
         ${where}
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...filterParams, limit, offset) as Array<Record<string, unknown>>;

    const mapped = items.map(row => ({
      ...row,
      platforms: row.platforms_csv ? String(row.platforms_csv).split(',') : [],
      platforms_csv: undefined,
    }));

    return NextResponse.json({ items: mapped, total, page, limit });
  } catch (err) {
    console.error('GET /api/books error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
