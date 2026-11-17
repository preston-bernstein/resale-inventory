import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { CATEGORIES, conditionsForCategory, DATE_RE, type Category } from '@/lib/constants';

export interface SharedFields {
  title: string;
  acquisition_cost: unknown;
  acquisition_date: unknown;
  condition: string | undefined;
  invalidFields: string[];
}

/** The `items` columns every category shares; only `category` itself varies. */
export interface BaseItemRow {
  id: string;
  tenantId: string;
  title: string;
  acquisition_cost: number;
  acquisition_date: string;
  now: string;
}

/** Validate + narrow `category`. */
export function validateCategory(
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

function isValidAcquisitionCost(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000
  );
}

function isValidAcquisitionDate(value: unknown): boolean {
  return typeof value === 'string' && DATE_RE.test(value);
}

/** Validate the fields shared by every category: title/cost/date/condition. */
export function validateSharedFields(body: Record<string, unknown>, cat: Category): SharedFields {
  const invalidFields: string[] = [];

  const title =
    typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : '';
  if (!title) invalidFields.push('title');

  if (!isValidAcquisitionCost(body.acquisition_cost)) invalidFields.push('acquisition_cost');
  if (!isValidAcquisitionDate(body.acquisition_date)) invalidFields.push('acquisition_date');

  const condition = body.condition as string | undefined;
  if (!condition || !conditionsForCategory(cat).includes(condition)) {
    invalidFields.push('condition');
  }

  return {
    title,
    acquisition_cost: body.acquisition_cost,
    acquisition_date: body.acquisition_date,
    condition,
    invalidFields,
  };
}

/** Build the standard 422 validation-failed response, or null if nothing invalid. */
export function invalidFieldsResponse(invalidFields: string[]): NextResponse | null {
  if (invalidFields.length === 0) return null;
  return NextResponse.json({ error: 'Validation failed.', fields: invalidFields }, { status: 422 });
}

/** Insert the shared `items` row — identical across every category, only `category` itself varies. */
export function insertBaseItemRow(category: string, row: BaseItemRow): void {
  const { id, tenantId, title, acquisition_cost, acquisition_date, now } = row;
  db.prepare(
    `INSERT INTO items
       (id, tenant_id, category, title, acquisition_cost, acquisition_date, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Unlisted', ?, ?)`,
  ).run(id, tenantId, category, title, acquisition_cost, acquisition_date, now, now);
}

/** Build the BaseItemRow for a new item from already-validated shared fields. */
export function newBaseItemRow(id: string, tenantId: string, shared: SharedFields): BaseItemRow {
  return {
    id,
    tenantId,
    title: shared.title,
    acquisition_cost: shared.acquisition_cost as number,
    acquisition_date: shared.acquisition_date as string,
    now: new Date().toISOString(),
  };
}
