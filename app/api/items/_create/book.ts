import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { normalizeISBN, lookupISBN, validateIsbnChecksum } from '@/lib/isbn';
import {
  insertBaseItemRow,
  invalidFieldsResponse,
  newBaseItemRow,
  type BaseItemRow,
  type SharedFields,
} from './shared';

type LookedUpBook = { title: string; author: string; publisher: string };

function isbnError(response: { error: string; fields?: string[] }): { error: NextResponse } {
  return { error: NextResponse.json(response, { status: 422 }) };
}

/** Check the ISBN's shape and checksum, then normalize it. Returns the 422 response on failure. */
function normalizeSubmittedIsbn(rawIsbn: string): { isbn: string } | { error: NextResponse } {
  const checksumResult = validateIsbnChecksum(rawIsbn);
  if (!checksumResult.valid) {
    return checksumResult.reason === 'checksum'
      ? isbnError({ error: 'ISBN checksum invalid.', fields: ['isbn'] })
      : isbnError({ error: 'Invalid ISBN format.' });
  }
  try {
    return { isbn: normalizeISBN(rawIsbn) };
  } catch {
    return isbnError({ error: 'Invalid ISBN format.' });
  }
}

/**
 * ISBN normalization + best-effort lookup, ported unchanged from
 * app/api/books/route.ts: a 'found' lookup only supplies defaults for
 * title/author/publisher when the body omits them; any other lookup
 * outcome (not-found / unavailable) never blocks creation (FR3/AC11).
 */
async function lookupIsbnForBook(
  body: Record<string, unknown>,
): Promise<
  { normalizedIsbn: string | null; lookedUp: LookedUpBook | null } | { error: NextResponse }
> {
  if (body.isbn === undefined || body.isbn === null || body.isbn === '') {
    return { normalizedIsbn: null, lookedUp: null };
  }

  const normalized = normalizeSubmittedIsbn(String(body.isbn));
  if ('error' in normalized) return normalized;

  const lookup = await lookupISBN(normalized.isbn);
  const lookedUp =
    lookup.status === 'found'
      ? { title: lookup.title, author: lookup.author, publisher: lookup.publisher }
      : null;
  return { normalizedIsbn: normalized.isbn, lookedUp };
}

/** A non-blank string from the body, trimmed; otherwise the trimmed lookup value, otherwise ''. */
function trimmedOrLookedUp(value: unknown, lookedUpValue: string | undefined): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return lookedUpValue?.trim() ?? '';
}

/**
 * Resolve final title/author/publisher for a book, applying the ISBN-lookup
 * fallback. Mutates `invalidFields` in place (adds/removes 'title', may add
 * 'author'), matching the original inline logic exactly.
 */
function resolveBookTitleAuthorPublisher(
  body: Record<string, unknown>,
  title: string,
  lookedUp: LookedUpBook | null,
  invalidFields: string[],
): { finalTitle: string; author: string; publisher: string } {
  const finalTitle = title || lookedUp?.title?.trim() || '';
  const titleIndex = invalidFields.indexOf('title');
  if (!finalTitle && titleIndex === -1) invalidFields.push('title');
  if (finalTitle && titleIndex !== -1) invalidFields.splice(titleIndex, 1);

  const author = trimmedOrLookedUp(body.author, lookedUp?.author);
  if (!author) invalidFields.push('author');

  const publisher = trimmedOrLookedUp(body.publisher, lookedUp?.publisher);

  return { finalTitle, author, publisher };
}

/** Duplicate ISBN check against book_details (not the archived `books` table). */
function checkDuplicateIsbn(normalizedIsbn: string | null): NextResponse | null {
  if (normalizedIsbn === null) return null;
  const existing = db
    .prepare('SELECT item_id FROM book_details WHERE isbn = ?')
    .get(normalizedIsbn);
  if (existing) {
    return NextResponse.json({ error: 'ISBN already exists.' }, { status: 409 });
  }
  return null;
}

interface BookDetailsInput {
  normalizedIsbn: string | null;
  author: string;
  publisher: string;
  condition: string;
}

/** Insert the items + book_details rows in a transaction. Returns a 409 response on a unique-constraint race, or null on success; rethrows any other error. */
function insertBookRecord(item: BaseItemRow, details: BookDetailsInput): NextResponse | null {
  try {
    db.transaction(() => {
      insertBaseItemRow('book', item);

      db.prepare(
        `INSERT INTO book_details (item_id, tenant_id, isbn, author, publisher, condition)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.tenantId,
        details.normalizedIsbn,
        details.author,
        details.publisher || null,
        details.condition,
      );
    })();
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return NextResponse.json({ error: 'ISBN already exists.' }, { status: 409 });
    }
    throw err;
  }
}

function fetchBookRow(id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT i.*, bd.isbn, bd.author, bd.publisher, bd.condition
         FROM items i JOIN book_details bd ON bd.item_id = i.id
        WHERE i.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

export async function handleBookCreate(
  body: Record<string, unknown>,
  shared: SharedFields,
  tenantId: string,
): Promise<NextResponse> {
  const { title, condition, invalidFields } = shared;

  const isbnResult = await lookupIsbnForBook(body);
  if ('error' in isbnResult) return isbnResult.error;
  const { normalizedIsbn, lookedUp } = isbnResult;

  const { finalTitle, author, publisher } = resolveBookTitleAuthorPublisher(
    body,
    title,
    lookedUp,
    invalidFields,
  );

  const invalidResponse = invalidFieldsResponse(invalidFields);
  if (invalidResponse) return invalidResponse;

  const dupResponse = checkDuplicateIsbn(normalizedIsbn);
  if (dupResponse) return dupResponse;

  const id = uuidv4();
  const item = { ...newBaseItemRow(id, tenantId, shared), title: finalTitle };

  const insertError = insertBookRecord(item, {
    normalizedIsbn,
    author,
    publisher,
    condition: condition as string,
  });
  if (insertError) return insertError;

  const row = fetchBookRow(id);
  return NextResponse.json({ ...row }, { status: 201 });
}
