import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { normalizeISBN, lookupISBN } from '@/lib/isbn';
import { CATEGORIES, conditionsForCategory, DATE_RE, type Category } from '@/lib/constants';
import {
  validateWeightOz,
  validateMeasurement,
  validateGenderDepartment,
  CLOTHING_MEASUREMENT_FIELDS,
} from '@/lib/clothing';

// ---------------------------------------------------------------------------
// POST /api/items — create a book or clothing item.
//
// Broken into small validate-then-insert-then-respond steps below; POST()
// itself is just the sequencing + the outer try/catch → 500 safety net.
// ---------------------------------------------------------------------------

type LookedUpBook = { title: string; author: string; publisher: string };

interface SharedFields {
  title: string;
  acquisition_cost: unknown;
  acquisition_date: unknown;
  condition: string | undefined;
  invalidFields: string[];
}

/** Parse the JSON request body. Mirrors the original inline try/catch. */
async function parseRequestBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) };
  }
}

/** Validate + narrow `category`. */
function validateCategory(
  body: Record<string, unknown>,
): { category: Category } | { error: NextResponse } {
  const category = body.category as string | undefined;
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
    return {
      error: NextResponse.json(
        { error: 'Validation failed.', fields: ['category'] },
        { status: 422 },
      ),
    };
  }
  return { category: category as Category };
}

/** Validate the fields shared by both categories: title/cost/date/condition. */
function validateSharedFields(body: Record<string, unknown>, cat: Category): SharedFields {
  const invalidFields: string[] = [];

  const title =
    typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '';
  if (!title) invalidFields.push('title');

  const acquisition_cost = body.acquisition_cost;
  const acquisitionCostValid =
    typeof acquisition_cost === 'number' &&
    Number.isInteger(acquisition_cost) &&
    acquisition_cost >= 0 &&
    acquisition_cost <= 100_000_000;
  if (!acquisitionCostValid) invalidFields.push('acquisition_cost');

  const acquisition_date = body.acquisition_date;
  if (typeof acquisition_date !== 'string' || !DATE_RE.test(acquisition_date)) {
    invalidFields.push('acquisition_date');
  }

  const condition = body.condition as string | undefined;
  if (!condition || !conditionsForCategory(cat).includes(condition)) {
    invalidFields.push('condition');
  }

  return { title, acquisition_cost, acquisition_date, condition, invalidFields };
}

/** Build the standard 422 validation-failed response, or null if nothing invalid. */
function invalidFieldsResponse(invalidFields: string[]): NextResponse | null {
  if (invalidFields.length === 0) return null;
  return NextResponse.json({ error: 'Validation failed.', fields: invalidFields }, { status: 422 });
}

// --- book branch helpers ----------------------------------------------------

/**
 * ISBN normalisation + best-effort lookup, ported unchanged from
 * app/api/books/route.ts: a 'found' lookup only supplies defaults for
 * title/author/publisher when the body omits them; any other lookup
 * outcome (not-found / unavailable) never blocks creation (FR3/AC11).
 */
async function lookupIsbnForBook(
  body: Record<string, unknown>,
): Promise<
  { normalizedIsbn: string | null; lookedUp: LookedUpBook | null } | { error: NextResponse }
> {
  let normalizedIsbn: string | null = null;
  let lookedUp: LookedUpBook | null = null;

  if (body.isbn !== undefined && body.isbn !== null && body.isbn !== '') {
    const rawIsbn = String(body.isbn);
    try {
      normalizedIsbn = normalizeISBN(rawIsbn);
    } catch {
      return { error: NextResponse.json({ error: 'Invalid ISBN format.' }, { status: 422 }) };
    }
    const lookup = await lookupISBN(normalizedIsbn);
    if (lookup.status === 'found') {
      lookedUp = { title: lookup.title, author: lookup.author, publisher: lookup.publisher };
    }
  }

  return { normalizedIsbn, lookedUp };
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
  if (!finalTitle) {
    if (!invalidFields.includes('title')) invalidFields.push('title');
  } else {
    const idx = invalidFields.indexOf('title');
    if (idx !== -1) invalidFields.splice(idx, 1);
  }

  const author =
    typeof body.author === 'string' && body.author.trim() !== ''
      ? body.author.trim()
      : lookedUp?.author?.trim() ?? '';
  if (!author) invalidFields.push('author');

  const publisher =
    typeof body.publisher === 'string' && body.publisher.trim() !== ''
      ? body.publisher.trim()
      : lookedUp?.publisher?.trim() ?? '';

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

/** Insert the items + book_details rows in a transaction. Returns a 409 response on a unique-constraint race, or null on success; rethrows any other error. */
function insertBookRecord(params: {
  id: string;
  finalTitle: string;
  acquisition_cost: number;
  acquisition_date: string;
  now: string;
  normalizedIsbn: string | null;
  author: string;
  publisher: string;
  condition: string;
}): NextResponse | null {
  const {
    id,
    finalTitle,
    acquisition_cost,
    acquisition_date,
    now,
    normalizedIsbn,
    author,
    publisher,
    condition,
  } = params;
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO items
           (id, category, title, acquisition_cost, acquisition_date, status, created_at, updated_at)
         VALUES (?, 'book', ?, ?, ?, 'Unlisted', ?, ?)`,
      ).run(id, finalTitle, acquisition_cost, acquisition_date, now, now);

      db.prepare(
        `INSERT INTO book_details (item_id, isbn, author, publisher, condition)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, normalizedIsbn, author, publisher || null, condition);
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

async function handleBookCreate(
  body: Record<string, unknown>,
  shared: SharedFields,
): Promise<NextResponse> {
  const { title, acquisition_cost, acquisition_date, condition, invalidFields } = shared;

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
  const now = new Date().toISOString();

  const insertError = insertBookRecord({
    id,
    finalTitle,
    acquisition_cost: acquisition_cost as number,
    acquisition_date: acquisition_date as string,
    now,
    normalizedIsbn,
    author,
    publisher,
    condition: condition as string,
  });
  if (insertError) return insertError;

  const row = fetchBookRow(id);
  return NextResponse.json({ ...row }, { status: 201 });
}

// --- clothing branch helpers ------------------------------------------------

interface ClothingFields {
  brand: string;
  size_label: string;
  color: string | null;
  material: string | null;
  gender_department: string | null;
  weight_oz: number | null;
  measurements: Record<string, number | null>;
}

/** Validate clothing-only fields, appending to the shared `invalidFields`. */
/** Validate brand/size_label/color/material — the free-text identity fields. */
function validateClothingIdentityFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { brand: string; size_label: string; color: string | null; material: string | null } {
  const brand =
    typeof body.brand === 'string' && body.brand.trim() !== '' ? body.brand.trim() : '';
  if (!brand) invalidFields.push('brand');

  // size_label: stored exactly as entered, only whitespace-trimmed —
  // never case- or format-normalized (FR9).
  const size_label =
    typeof body.size_label === 'string' && body.size_label.trim() !== ''
      ? body.size_label.trim()
      : '';
  if (!size_label) invalidFields.push('size_label');

  const color = typeof body.color === 'string' ? body.color.trim() || null : null;
  if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
    invalidFields.push('color');
  }

  const material = typeof body.material === 'string' ? body.material.trim() || null : null;
  if (
    body.material !== undefined &&
    body.material !== null &&
    typeof body.material !== 'string'
  ) {
    invalidFields.push('material');
  }

  return { brand, size_label, color, material };
}

/** Validate gender_department + weight_oz — the scalar attribute fields. */
function validateClothingAttributeFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { gender_department: string | null; weight_oz: number | null } {
  if (!validateGenderDepartment(body.gender_department)) {
    invalidFields.push('gender_department');
  }
  const gender_department =
    typeof body.gender_department === 'string' ? body.gender_department : null;

  if (!validateWeightOz(body.weight_oz)) {
    invalidFields.push('weight_oz');
  }
  const weight_oz =
    body.weight_oz === undefined || body.weight_oz === null ? null : (body.weight_oz as number);

  return { gender_department, weight_oz };
}

/** Validate the 8-field measurement allowlist (FR5). */
function validateClothingMeasurements(
  body: Record<string, unknown>,
  invalidFields: string[],
): Record<string, number | null> {
  const measurements: Record<string, number | null> = {};
  for (const field of CLOTHING_MEASUREMENT_FIELDS) {
    const value = body[field];
    if (!validateMeasurement(value)) {
      invalidFields.push(field);
    }
    measurements[field] = value === undefined || value === null ? null : (value as number);
  }
  return measurements;
}

function validateClothingFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): ClothingFields {
  const identity = validateClothingIdentityFields(body, invalidFields);
  const attributes = validateClothingAttributeFields(body, invalidFields);
  const measurements = validateClothingMeasurements(body, invalidFields);

  return { ...identity, ...attributes, measurements };
}

/** Insert the items + clothing_details rows in a transaction. Errors propagate (→ outer 500), unlike the book branch. */
function insertClothingRecord(params: {
  id: string;
  title: string;
  acquisition_cost: number;
  acquisition_date: string;
  now: string;
  fields: ClothingFields;
  condition: string;
}): void {
  const { id, title, acquisition_cost, acquisition_date, now, fields, condition } = params;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO items
         (id, category, title, acquisition_cost, acquisition_date, status, created_at, updated_at)
       VALUES (?, 'clothing', ?, ?, ?, 'Unlisted', ?, ?)`,
    ).run(id, title, acquisition_cost, acquisition_date, now, now);

    db.prepare(
      `INSERT INTO clothing_details
         (item_id, brand, size_label, color, material, gender_department, weight_oz,
          pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
          leg_opening_in, hip_in, condition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      fields.brand,
      fields.size_label,
      fields.color,
      fields.material,
      fields.gender_department,
      fields.weight_oz,
      fields.measurements.pit_to_pit_in,
      fields.measurements.length_in,
      fields.measurements.sleeve_length_in,
      fields.measurements.waist_in,
      fields.measurements.rise_in,
      fields.measurements.inseam_in,
      fields.measurements.leg_opening_in,
      fields.measurements.hip_in,
      condition,
    );
  })();
}

function fetchClothingRow(id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT i.*, cd.brand, cd.size_label, cd.color, cd.material, cd.gender_department,
              cd.weight_oz, cd.pit_to_pit_in, cd.length_in, cd.sleeve_length_in, cd.waist_in,
              cd.rise_in, cd.inseam_in, cd.leg_opening_in, cd.hip_in, cd.condition
         FROM items i JOIN clothing_details cd ON cd.item_id = i.id
        WHERE i.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

function handleClothingCreate(body: Record<string, unknown>, shared: SharedFields): NextResponse {
  const { title, acquisition_cost, acquisition_date, condition, invalidFields } = shared;

  const fields = validateClothingFields(body, invalidFields);

  const invalidResponse = invalidFieldsResponse(invalidFields);
  if (invalidResponse) return invalidResponse;

  const id = uuidv4();
  const now = new Date().toISOString();

  insertClothingRecord({
    id,
    title,
    acquisition_cost: acquisition_cost as number,
    acquisition_date: acquisition_date as string,
    now,
    fields,
    condition: condition as string,
  });

  const row = fetchClothingRow(id);
  return NextResponse.json({ ...row }, { status: 201 });
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequestBody(request);
    if ('error' in parsed) return parsed.error;
    const { body } = parsed;

    const categoryResult = validateCategory(body);
    if ('error' in categoryResult) return categoryResult.error;
    const cat = categoryResult.category;

    const shared = validateSharedFields(body, cat);

    if (cat === 'book') {
      return await handleBookCreate(body, shared);
    }
    return handleClothingCreate(body, shared);
  } catch (err) {
    console.error('POST /api/items error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/items — search across both categories.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const rawPage = searchParams.get('page');
    const page = rawPage === null ? 0 : parseInt(rawPage, 10);
    if (rawPage !== null && (!Number.isInteger(page) || page < 0)) {
      return NextResponse.json({ error: 'page must be a non-negative integer.' }, { status: 400 });
    }

    const rawLimit = searchParams.get('limit');
    const limit = rawLimit === null ? 25 : parseInt(rawLimit, 10);
    if (rawLimit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      return NextResponse.json({ error: 'limit must be 1–200.' }, { status: 400 });
    }
    const offset = page * limit;

    const q = searchParams.get('q') ?? '';
    if (q.length > 200) {
      return NextResponse.json({ error: 'q exceeds 200 characters.' }, { status: 400 });
    }

    const categoryParam = searchParams.get('category');
    if (categoryParam !== null && !(CATEGORIES as readonly string[]).includes(categoryParam)) {
      return NextResponse.json({ error: 'Invalid category.' }, { status: 400 });
    }
    const category = categoryParam as Category | null;

    const status = searchParams.get('status') ?? '';
    const condition = searchParams.get('condition') ?? '';

    // condition is validated against the selected category's vocabulary only
    // when both `condition` and `category` are supplied together — that's
    // the only combination where "the selected category's vocabulary" is
    // unambiguous. In that case a condition outside the vocabulary is a
    // 422 (bad input), not a silently-empty result set.
    if (condition && category) {
      const vocab = conditionsForCategory(category);
      if (!vocab.includes(condition)) {
        return NextResponse.json(
          { error: 'Validation failed.', fields: ['condition'] },
          { status: 422 },
        );
      }
    }

    const filterClauses: string[] = [];
    const filterParams: unknown[] = [];

    if (q) {
      filterClauses.push("(i.title LIKE ? OR (i.category = 'book' AND bd.author LIKE ?))");
      filterParams.push(`%${q}%`, `%${q}%`);
    }
    if (category) {
      filterClauses.push('i.category = ?');
      filterParams.push(category);
    }
    if (condition) {
      filterClauses.push('COALESCE(bd.condition, cd.condition) = ?');
      filterParams.push(condition);
    }
    if (status) {
      filterClauses.push('i.status = ?');
      filterParams.push(status);
    }

    const where = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';

    const fromJoin = `FROM items i
       LEFT JOIN book_details bd ON bd.item_id = i.id
       LEFT JOIN clothing_details cd ON cd.item_id = i.id`;

    const total = (
      db.prepare(`SELECT COUNT(*) as count ${fromJoin} ${where}`).get(...filterParams) as {
        count: number;
      }
    ).count;

    const rows = db
      .prepare(
        `SELECT i.*,
            bd.isbn as bd_isbn, bd.author as bd_author, bd.publisher as bd_publisher,
            bd.condition as bd_condition,
            cd.brand as cd_brand, cd.size_label as cd_size_label, cd.color as cd_color,
            cd.material as cd_material, cd.gender_department as cd_gender_department,
            cd.weight_oz as cd_weight_oz, cd.pit_to_pit_in as cd_pit_to_pit_in,
            cd.length_in as cd_length_in, cd.sleeve_length_in as cd_sleeve_length_in,
            cd.waist_in as cd_waist_in, cd.rise_in as cd_rise_in, cd.inseam_in as cd_inseam_in,
            cd.leg_opening_in as cd_leg_opening_in, cd.hip_in as cd_hip_in,
            cd.condition as cd_condition,
            COALESCE(GROUP_CONCAT(ip.platform, ','), '') as platforms_csv
         ${fromJoin}
         LEFT JOIN item_platforms ip ON ip.item_id = i.id
         ${where}
         GROUP BY i.id
         ORDER BY i.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...filterParams, limit, offset) as Array<Record<string, unknown>>;

    const items = rows.map(row => {
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
      };

      if (row.category === 'book') {
        return {
          ...base,
          details: {
            isbn: row.bd_isbn,
            author: row.bd_author,
            publisher: row.bd_publisher,
            condition: row.bd_condition,
          },
        };
      }

      return {
        ...base,
        details: {
          brand: row.cd_brand,
          size_label: row.cd_size_label,
          color: row.cd_color,
          material: row.cd_material,
          gender_department: row.cd_gender_department,
          weight_oz: row.cd_weight_oz,
          pit_to_pit_in: row.cd_pit_to_pit_in,
          length_in: row.cd_length_in,
          sleeve_length_in: row.cd_sleeve_length_in,
          waist_in: row.cd_waist_in,
          rise_in: row.cd_rise_in,
          inseam_in: row.cd_inseam_in,
          leg_opening_in: row.cd_leg_opening_in,
          hip_in: row.cd_hip_in,
          condition: row.cd_condition,
        },
      };
    });

    return NextResponse.json({ items, total, page, limit });
  } catch (err) {
    console.error('GET /api/items error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
