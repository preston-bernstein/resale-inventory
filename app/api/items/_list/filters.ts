import { escapeLike, expandQuery } from '@/lib/searchExpand';
import type { ParsedListQuery } from './query';

interface FilterClause {
  clause: string;
  params: unknown[];
}

const SEARCH_FIELDS = [
  'i.title',
  'bd.author',
  'bd.publisher',
  'bd.isbn',
  'cd.brand',
  'cd.color',
  'cd.material',
  'cd.gender_department',
  'cd.size_label',
  'ed.brand',
  'ed.model',
];

/**
 * "Similar words" search (ported from the internal-scraper-service project's
 * lib/thesaurus.ts pattern): tokenize the query, expand each token to its
 * curated synonyms, and OR-match every expanded term against every
 * searchable field on every category. Each term is LIKE-escaped so a
 * literal `%` or `_` in a query can't act as a wildcard.
 */
function buildSearchClause(q: string): FilterClause | null {
  if (!q) return null;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const termClauses: string[] = [];
  const params: unknown[] = [];
  for (const term of expandQuery(terms)) {
    const pattern = `%${escapeLike(term)}%`;
    for (const field of SEARCH_FIELDS) {
      termClauses.push(`${field} LIKE ? ESCAPE '\\'`);
      params.push(pattern);
    }
  }
  if (termClauses.length === 0) return null;
  return { clause: `(${termClauses.join(' OR ')})`, params };
}

/** Exact-match filters: each applies only when its query value is non-empty. */
function exactFilters(parsed: ParsedListQuery): Array<[string | null, string]> {
  return [
    [parsed.category, 'i.category = ?'],
    [parsed.condition, 'COALESCE(bd.condition, cd.condition, ed.condition) = ?'],
    [parsed.status, 'i.status = ?'],
  ];
}

/** Build the WHERE-clause fragments + bound params for GET /api/items, from an already-parsed+validated query. */
export function buildItemFilters(
  tenantId: string,
  parsed: ParsedListQuery,
): { filterClauses: string[]; filterParams: unknown[] } {
  // Unconditionally seeded BEFORE any optional filter below, so the
  // "no filters supplied" case still scopes to the authenticated tenant
  // instead of skipping the WHERE clause entirely (FR2/FR4).
  const filterClauses: string[] = ['i.tenant_id = ?'];
  const filterParams: unknown[] = [tenantId];

  const search = buildSearchClause(parsed.q);
  if (search) {
    filterClauses.push(search.clause);
    filterParams.push(...search.params);
  }
  for (const [value, clause] of exactFilters(parsed)) {
    if (!value) continue;
    filterClauses.push(clause);
    filterParams.push(value);
  }

  return { filterClauses, filterParams };
}
