import { NextResponse } from 'next/server';
import { CATEGORIES, conditionsForCategory, type Category } from '@/lib/constants';

export interface ParsedListQuery {
  page: number;
  limit: number;
  offset: number;
  q: string;
  category: Category | null;
  status: string;
  condition: string;
}

function parsePagination(
  searchParams: URLSearchParams,
): { page: number; limit: number; offset: number } | NextResponse {
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

  return { page, limit, offset: page * limit };
}

function parseSearchQuery(searchParams: URLSearchParams): string | NextResponse {
  const q = searchParams.get('q') ?? '';
  if (q.length > 200) {
    return NextResponse.json({ error: 'q exceeds 200 characters.' }, { status: 400 });
  }
  return q;
}

function parseCategoryFilter(searchParams: URLSearchParams): Category | null | NextResponse {
  const categoryParam = searchParams.get('category');
  if (categoryParam !== null && !(CATEGORIES as readonly string[]).includes(categoryParam)) {
    return NextResponse.json({ error: 'Invalid category.' }, { status: 400 });
  }
  return categoryParam as Category | null;
}

// condition is validated against the selected category's vocabulary only
// when both `condition` and `category` are supplied together — that's the
// only combination where "the selected category's vocabulary" is
// unambiguous. In that case a condition outside the vocabulary is a 422
// (bad input), not a silently-empty result set.
function validateConditionForCategory(condition: string, category: Category | null): NextResponse | null {
  if (!condition || !category) return null;
  const vocab = conditionsForCategory(category);
  if (!vocab.includes(condition)) {
    return NextResponse.json({ error: 'Validation failed.', fields: ['condition'] }, { status: 422 });
  }
  return null;
}

/** Parse + validate every GET /api/items query param, one small function per field. */
export function parseListQueryParams(searchParams: URLSearchParams): ParsedListQuery | NextResponse {
  const pagination = parsePagination(searchParams);
  if (pagination instanceof NextResponse) return pagination;

  const q = parseSearchQuery(searchParams);
  if (q instanceof NextResponse) return q;

  const category = parseCategoryFilter(searchParams);
  if (category instanceof NextResponse) return category;

  const status = searchParams.get('status') ?? '';
  const condition = searchParams.get('condition') ?? '';

  const conditionError = validateConditionForCategory(condition, category);
  if (conditionError) return conditionError;

  return { ...pagination, q, category, status, condition };
}
