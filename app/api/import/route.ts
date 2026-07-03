import { NextRequest, NextResponse } from 'next/server';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { usdToCents } from '@/lib/money';
import { normalizeISBN } from '@/lib/isbn';
import { CONDITIONS, DATE_RE } from '@/lib/constants';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const REQUIRED_FIELDS = ['title', 'author', 'condition', 'acquisition_cost_usd', 'acquisition_date'] as const;

const VALID_CONDITIONS = new Set<string>(CONDITIONS);

// Sale-related fields to ignore from CSV
const IGNORED_FIELDS = new Set(['sale_price_usd', 'sale_platform', 'sale_date', 'status']);

interface ImportError {
  row: number;
  fields: string[];
  message: string;
}

interface ValidRow {
  id: string;
  title: string;
  author: string;
  publisher: string | null;
  isbn: string | null;
  condition: string;
  acquisition_cost: number;
  acquisition_date: string;
}

export async function POST(request: NextRequest) {
  try {
    // Check Content-Length header before reading body
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      return new Response('File too large', { status: 413 });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Invalid multipart form data' }, { status: 400 });
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Check actual file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response('File too large', { status: 413 });
    }

    const text = await file.text();

    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });

    const errors: ImportError[] = [];
    const validRows: ValidRow[] = [];
    const seenIsbns = new Set<string>();
    const isbnExists = db.prepare('SELECT id FROM books WHERE isbn = ?');

    for (let i = 0; i < parsed.data.length; i++) {
      const rawRow = parsed.data[i];
      // Normalize keys: trim whitespace and strip BOM
      const row: Record<string, string> = {};
      for (const key of Object.keys(rawRow)) {
        const normalizedKey = key.replace(/^﻿/, '').trim();
        row[normalizedKey] = rawRow[key];
      }

      const csvRow = i + 2; // 1-based, row 1 is header

      // Check required fields
      const missingFields = REQUIRED_FIELDS.filter(
        (f) => row[f] === undefined || row[f].trim() === ''
      );

      if (missingFields.length > 0) {
        errors.push({
          row: csvRow,
          fields: missingFields,
          message: `Missing required fields: ${missingFields.join(', ')}`,
        });
        continue;
      }

      // Validate condition
      const condition = row['condition'].trim();
      if (!VALID_CONDITIONS.has(condition)) {
        errors.push({
          row: csvRow,
          fields: ['condition'],
          message: `Invalid condition: "${condition}". Must be one of: Poor, Acceptable, Good, Very Good, Like New`,
        });
        continue;
      }

      // Validate and convert acquisition_cost_usd
      let acquisition_cost: number;
      try {
        acquisition_cost = usdToCents(row['acquisition_cost_usd'].trim());
      } catch (err) {
        errors.push({
          row: csvRow,
          fields: ['acquisition_cost_usd'],
          message: `Invalid acquisition_cost_usd: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Validate acquisition_date format YYYY-MM-DD
      const acquisition_date = row['acquisition_date'].trim();
      if (!DATE_RE.test(acquisition_date)) {
        errors.push({
          row: csvRow,
          fields: ['acquisition_date'],
          message: `Invalid acquisition_date format: "${acquisition_date}". Expected YYYY-MM-DD`,
        });
        continue;
      }

      // Optional fields (ignore sale-related fields)
      const title = row['title'].trim();
      const author = row['author'].trim();
      const publisher = row['publisher']?.trim() || null;
      const rawIsbn = row['isbn']?.trim() || null;

      let isbn: string | null = null;
      if (rawIsbn) {
        try {
          isbn = normalizeISBN(rawIsbn);
        } catch (err) {
          errors.push({
            row: csvRow,
            fields: ['isbn'],
            message: err instanceof Error ? err.message : 'Invalid ISBN format.',
          });
          continue;
        }

        if (seenIsbns.has(isbn)) {
          errors.push({
            row: csvRow,
            fields: ['isbn'],
            message: `Duplicate ISBN "${isbn}": already present earlier in this file.`,
          });
          continue;
        }

        if (isbnExists.get(isbn)) {
          errors.push({
            row: csvRow,
            fields: ['isbn'],
            message: `Duplicate ISBN "${isbn}": already exists in inventory.`,
          });
          continue;
        }

        seenIsbns.add(isbn);
      }

      validRows.push({
        id: uuidv4(),
        title,
        author,
        publisher,
        isbn,
        condition,
        acquisition_cost,
        acquisition_date,
      });
    }

    // Batch insert in a single transaction
    const insert = db.prepare(`
      INSERT INTO books (id, title, author, publisher, isbn, condition, acquisition_cost, acquisition_date, status)
      VALUES (@id, @title, @author, @publisher, @isbn, @condition, @acquisition_cost, @acquisition_date, 'Unlisted')
    `);

    const insertAll = db.transaction((rows: ValidRow[]) => {
      for (const row of rows) {
        insert.run(row);
      }
    });

    insertAll(validRows);

    return NextResponse.json({ imported: validRows.length, errors });
  } catch (err) {
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
}
