import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { usdToCents } from '@/lib/money';
import { normalizeISBN } from '@/lib/isbn';
import { CATEGORIES, conditionsForCategory, DATE_RE, type Category } from '@/lib/constants';
import {
  validateWeightOz,
  validateMeasurement,
  validateGenderDepartment,
  CLOTHING_MEASUREMENT_FIELDS,
} from '@/lib/clothing';
import type { BookDetails, ClothingDetails } from '@/lib/types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Category-specific required-field lists. `category` itself is validated
// separately (before these run) since it determines which list applies.
// Sale-related columns (sale_price_usd, sale_platform, sale_date, status) are
// never read below, so they're ignored on import by construction — every
// imported row is created with status 'Unlisted' regardless of what a CSV's
// status column says (FR22/AC12).
const BOOK_REQUIRED_FIELDS = ['title', 'author', 'condition', 'acquisition_cost_usd', 'acquisition_date'] as const;
const CLOTHING_REQUIRED_FIELDS = ['title', 'brand', 'size_label', 'condition', 'acquisition_cost_usd', 'acquisition_date'] as const;

interface ImportError {
  row: number;
  fields: string[];
  message: string;
}

// Reuses the field lists already defined on BookDetails/ClothingDetails
// (lib/types.ts) rather than redeclaring them here — `condition` is
// overridden as a plain `string` because at this point in the pipeline it
// has only been checked against conditionsForCategory(), not narrowed to
// the category-specific literal union yet.
interface ValidBookRow extends Omit<BookDetails, 'condition'> {
  id: string;
  category: 'book';
  title: string;
  condition: string;
  acquisition_cost: number;
  acquisition_date: string;
}

interface ValidClothingRow extends Omit<ClothingDetails, 'condition'> {
  id: string;
  category: 'clothing';
  title: string;
  condition: string;
  acquisition_cost: number;
  acquisition_date: string;
}

type ValidRow = ValidBookRow | ValidClothingRow;

// Fields shared by every category once title/condition/cost/date have all
// passed validation, handed off to the per-category row builders below.
interface CommonRowFields {
  title: string;
  condition: string;
  acquisition_cost: number;
  acquisition_date: string;
}

type FileUploadResult = { ok: true; file: File } | { ok: false; response: Response };
type CategoryResult = { category: Category } | { error: ImportError };
type ConditionResult = { condition: string } | { error: ImportError };
type CostResult = { cost: number } | { error: ImportError };
type DateResult = { date: string } | { error: ImportError };
type BookRowResult = { row: ValidBookRow } | { error: ImportError };
type ClothingRowResult = { row: ValidClothingRow } | { error: ImportError };
type RowResult = { row: ValidRow } | { error: ImportError };

/**
 * Parse a CSV cell for a clothing numeric field (weight_oz / the 8
 * measurement columns). These arrive as strings and are empty for book
 * rows — empty string or a non-numeric value is treated as "not provided"
 * (null), never as zero or a validation error at this stage. Out-of-range
 * values (negative, non-integer weight, etc.) that DO parse as a number
 * are still caught by validateWeightOz/validateMeasurement below.
 */
function parseClothingNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (Number.isNaN(n)) return null;
  return n;
}

/**
 * Validate and read the uploaded file: Content-Length header pre-check,
 * multipart parse, presence/type check, and actual-size check. Returns
 * either the parsed File or the exact Response the route should return.
 */
async function readUploadedFile(request: NextRequest): Promise<FileUploadResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
    return { ok: false, response: new Response('File too large', { status: 413 }) };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 }) };
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return { ok: false, response: NextResponse.json({ error: 'No file provided' }, { status: 400 }) };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, response: new Response('File too large', { status: 413 }) };
  }

  return { ok: true, file };
}

/** Trim whitespace and strip a leading BOM from a raw CSV row's keys. */
function normalizeRowKeys(rawRow: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const key of Object.keys(rawRow)) {
    const normalizedKey = key.replace(/^﻿/, '').trim();
    row[normalizedKey] = rawRow[key];
  }
  return row;
}

/** Validate a row's `category` value, which determines every check after it. */
function validateRowCategory(row: Record<string, string>, csvRow: number): CategoryResult {
  const rawCategory = row['category']?.trim() ?? '';
  if (!rawCategory || !(CATEGORIES as readonly string[]).includes(rawCategory)) {
    return {
      error: {
        row: csvRow,
        fields: ['category'],
        message: `Invalid category: "${rawCategory}". Must be one of: ${CATEGORIES.join(', ')}`,
      },
    };
  }
  return { category: rawCategory as Category };
}

/** Check that every category-specific required field is present and non-blank. */
function validateRequiredFields(
  row: Record<string, string>,
  category: Category,
  csvRow: number,
): ImportError | null {
  const requiredFields = category === 'book' ? BOOK_REQUIRED_FIELDS : CLOTHING_REQUIRED_FIELDS;
  const missingFields = requiredFields.filter(
    (f) => row[f] === undefined || row[f].trim() === ''
  );

  if (missingFields.length === 0) return null;

  return {
    row: csvRow,
    fields: missingFields,
    message: `Missing required fields: ${missingFields.join(', ')}`,
  };
}

/** Validate `condition` against the category-specific vocabulary. */
function validateRowCondition(
  row: Record<string, string>,
  category: Category,
  csvRow: number,
): ConditionResult {
  const condition = row['condition'].trim();
  const validConditions = conditionsForCategory(category);
  if (!validConditions.includes(condition)) {
    return {
      error: {
        row: csvRow,
        fields: ['condition'],
        message: `Invalid condition: "${condition}". Must be one of: ${validConditions.join(', ')}`,
      },
    };
  }
  return { condition };
}

/** Validate and convert `acquisition_cost_usd` to integer cents. */
function validateAcquisitionCost(row: Record<string, string>, csvRow: number): CostResult {
  try {
    const cost = usdToCents(row['acquisition_cost_usd'].trim());
    return { cost };
  } catch (err) {
    return {
      error: {
        row: csvRow,
        fields: ['acquisition_cost_usd'],
        message: `Invalid acquisition_cost_usd: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/** Validate `acquisition_date` is in YYYY-MM-DD format. */
function validateAcquisitionDate(row: Record<string, string>, csvRow: number): DateResult {
  const date = row['acquisition_date'].trim();
  if (!DATE_RE.test(date)) {
    return {
      error: {
        row: csvRow,
        fields: ['acquisition_date'],
        message: `Invalid acquisition_date format: "${date}". Expected YYYY-MM-DD`,
      },
    };
  }
  return { date };
}

/**
 * Build a validated book row: author/publisher passthrough plus ISBN
 * normalization and duplicate detection (within-file and against the
 * existing inventory).
 */
function buildBookRow(
  row: Record<string, string>,
  csvRow: number,
  common: CommonRowFields,
  seenIsbns: Set<string>,
  isbnExists: ReturnType<typeof db.prepare>,
): BookRowResult {
  const author = row['author'].trim();
  const publisher = row['publisher']?.trim() || null;
  const rawIsbn = row['isbn']?.trim() || null;

  let isbn: string | null = null;
  if (rawIsbn) {
    try {
      isbn = normalizeISBN(rawIsbn);
    } catch (err) {
      return {
        error: {
          row: csvRow,
          fields: ['isbn'],
          message: err instanceof Error ? err.message : 'Invalid ISBN format.',
        },
      };
    }

    if (seenIsbns.has(isbn)) {
      return {
        error: {
          row: csvRow,
          fields: ['isbn'],
          message: `Duplicate ISBN "${isbn}": already present earlier in this file.`,
        },
      };
    }

    if (isbnExists.get(isbn)) {
      return {
        error: {
          row: csvRow,
          fields: ['isbn'],
          message: `Duplicate ISBN "${isbn}": already exists in inventory.`,
        },
      };
    }

    seenIsbns.add(isbn);
  }

  return {
    row: {
      id: uuidv4(),
      category: 'book',
      title: common.title,
      author,
      publisher,
      isbn,
      condition: common.condition,
      acquisition_cost: common.acquisition_cost,
      acquisition_date: common.acquisition_date,
    },
  };
}

/**
 * Build a validated clothing row: brand/size/color/material passthrough,
 * gender_department, weight_oz, and the 8 measurement fields.
 */
function buildClothingRow(
  row: Record<string, string>,
  csvRow: number,
  common: CommonRowFields,
): ClothingRowResult {
  // color/material are optional (consistent with the UI-add path).
  // size_label is stored exactly as entered, only whitespace-trimmed —
  // never normalized (FR9).
  const brand = row['brand'].trim();
  const size_label = row['size_label'].trim();
  const color = row['color']?.trim() || null;
  const material = row['material']?.trim() || null;

  const rawGenderDept = row['gender_department']?.trim();
  const gender_department = rawGenderDept ? rawGenderDept : null;
  if (!validateGenderDepartment(gender_department)) {
    return {
      error: {
        row: csvRow,
        fields: ['gender_department'],
        message: 'Invalid gender_department.',
      },
    };
  }

  const weight_oz = parseClothingNumber(row['weight_oz']);
  if (!validateWeightOz(weight_oz)) {
    return {
      error: {
        row: csvRow,
        fields: ['weight_oz'],
        message: `Invalid weight_oz: "${row['weight_oz']}". Must be a non-negative integer.`,
      },
    };
  }

  const measurements: Record<string, number | null> = {};
  const invalidMeasurementFields: string[] = [];
  for (const field of CLOTHING_MEASUREMENT_FIELDS) {
    const value = parseClothingNumber(row[field]);
    if (!validateMeasurement(value)) {
      invalidMeasurementFields.push(field);
    }
    measurements[field] = value;
  }

  if (invalidMeasurementFields.length > 0) {
    return {
      error: {
        row: csvRow,
        fields: invalidMeasurementFields,
        message: `Invalid measurement value(s): ${invalidMeasurementFields.join(', ')}. Must be non-negative numbers.`,
      },
    };
  }

  return {
    row: {
      id: uuidv4(),
      category: 'clothing',
      title: common.title,
      brand,
      size_label,
      color,
      material,
      gender_department,
      weight_oz,
      pit_to_pit_in: measurements.pit_to_pit_in,
      length_in: measurements.length_in,
      sleeve_length_in: measurements.sleeve_length_in,
      waist_in: measurements.waist_in,
      rise_in: measurements.rise_in,
      inseam_in: measurements.inseam_in,
      leg_opening_in: measurements.leg_opening_in,
      hip_in: measurements.hip_in,
      condition: common.condition,
      acquisition_cost: common.acquisition_cost,
      acquisition_date: common.acquisition_date,
    },
  };
}

/**
 * Run every validation step for one CSV row (category → required fields →
 * condition → cost → date → category-specific fields), short-circuiting on
 * the first failure, and return either the validated row or its error.
 */
function processImportRow(
  rawRow: Record<string, string>,
  csvRow: number,
  seenIsbns: Set<string>,
  isbnExists: ReturnType<typeof db.prepare>,
): RowResult {
  const row = normalizeRowKeys(rawRow);

  const categoryResult = validateRowCategory(row, csvRow);
  if ('error' in categoryResult) return categoryResult;
  const { category } = categoryResult;

  const requiredFieldsError = validateRequiredFields(row, category, csvRow);
  if (requiredFieldsError) return { error: requiredFieldsError };

  const conditionResult = validateRowCondition(row, category, csvRow);
  if ('error' in conditionResult) return conditionResult;

  const costResult = validateAcquisitionCost(row, csvRow);
  if ('error' in costResult) return costResult;

  const dateResult = validateAcquisitionDate(row, csvRow);
  if ('error' in dateResult) return dateResult;

  const common: CommonRowFields = {
    title: row['title'].trim(),
    condition: conditionResult.condition,
    acquisition_cost: costResult.cost,
    acquisition_date: dateResult.date,
  };

  return category === 'book'
    ? buildBookRow(row, csvRow, common, seenIsbns, isbnExists)
    : buildClothingRow(row, csvRow, common);
}

/**
 * Insert all validated rows in a single transaction: all rows commit
 * together, or none do. Every row already passed validation in
 * processImportRow, so the only failures possible here are DB-level
 * (constraint races), handled by the caller's outer catch.
 */
function insertValidRows(rows: ValidRow[]): void {
  const insertItem = db.prepare(`
    INSERT INTO items (id, category, title, acquisition_cost, acquisition_date, status)
    VALUES (@id, @category, @title, @acquisition_cost, @acquisition_date, 'Unlisted')
  `);

  const insertBookDetails = db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition)
    VALUES (@id, @isbn, @author, @publisher, @condition)
  `);

  const insertClothingDetails = db.prepare(`
    INSERT INTO clothing_details
      (item_id, brand, size_label, color, material, gender_department, weight_oz,
       pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
       leg_opening_in, hip_in, condition)
    VALUES (@id, @brand, @size_label, @color, @material, @gender_department, @weight_oz,
       @pit_to_pit_in, @length_in, @sleeve_length_in, @waist_in, @rise_in, @inseam_in,
       @leg_opening_in, @hip_in, @condition)
  `);

  const insertAll = db.transaction((rowsToInsert: ValidRow[]) => {
    for (const row of rowsToInsert) {
      insertItem.run(row);
      if (row.category === 'book') {
        insertBookDetails.run(row);
      } else {
        insertClothingDetails.run(row);
      }
    }
  });

  insertAll(rows);
}

/** Map a thrown DB error to the correct error Response for this route. */
function mapImportDbError(err: unknown): NextResponse {
  const code = (err as { code?: string }).code;
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    console.error('[POST /api/import] CHECK constraint:', err);
    return NextResponse.json({ error: 'Validation failed.' }, { status: 422 });
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.error('[POST /api/import] UNIQUE constraint:', err);
    return NextResponse.json({ error: 'Conflicts with an existing record.' }, { status: 409 });
  }
  console.error('[POST /api/import] Internal error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const uploadResult = await readUploadedFile(request);
    if (!uploadResult.ok) {
      return uploadResult.response;
    }

    const text = await uploadResult.file.text();

    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });

    const errors: ImportError[] = [];
    const validRows: ValidRow[] = [];
    const seenIsbns = new Set<string>();
    const isbnExists = db.prepare('SELECT item_id FROM book_details WHERE isbn = ?');

    for (let i = 0; i < parsed.data.length; i++) {
      const csvRow = i + 2; // 1-based, row 1 is header
      const result = processImportRow(parsed.data[i], csvRow, seenIsbns, isbnExists);
      if ('error' in result) {
        errors.push(result.error);
      } else {
        validRows.push(result.row);
      }
    }

    insertValidRows(validRows);

    return NextResponse.json({ imported: validRows.length, errors });
  } catch (err) {
    return mapImportDbError(err);
  }
}
