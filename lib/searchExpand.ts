// "Similar words" search expansion, ported from the estate-scraper project's
// lib/thesaurus.ts pattern: a static, checked-in synonym map so a query for one
// everyday word ("jacket") also matches items described with a different word
// ("coat", "blazer"). Deterministic, no I/O, no LLM call.
//
// estate-scraper's version additionally implied a taxonomy category from the
// query (its 15-value finding_items.category vocab); that layer is intentionally
// NOT ported here — this app already has an explicit category filter (book /
// clothing) in the UI, so inferring category from free text would be redundant.
// Only the term-expansion + LIKE-escaping primitives are ported.

// Each inner array is a group of interchangeable terms: matching any term in a
// query expands to every other term in its group.
const SYNONYM_GROUPS: string[][] = [
  ['jacket', 'coat', 'blazer', 'parka', 'windbreaker', 'bomber'],
  ['jeans', 'denim', 'dungarees'],
  ['sneakers', 'shoes', 'trainers', 'kicks', 'athletic shoes'],
  ['sweater', 'pullover', 'jumper'],
  ['hoodie', 'sweatshirt', 'hooded sweatshirt'],
  ['shirt', 't-shirt', 'tee', 'tshirt', 't shirt', 'button-down', 'button-up', 'oxford shirt'],
  ['dress', 'gown'],
  ['skirt', 'mini skirt', 'midi skirt'],
  ['shorts', 'trunks'],
  ['vintage', 'retro', 'throwback'],
  ['navy', 'blue'],
  ['maroon', 'burgundy', 'wine'],
  ['olive', 'khaki'],
  ['tan', 'beige', 'cream'],
  ['black', 'ebony'],
  ['mens', "men's", 'male'],
  ['womens', "women's", 'female'],
  ['hardcover', 'hardback'],
  ['paperback', 'softcover', 'softback'],
  ['signed', 'autographed'],
  ['first edition', '1st edition'],
];

// Lower-cased term -> the full set of terms interchangeable with it (its own
// group, unioned across every group it appears in).
const TERM_TO_GROUP = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const lowered = group.map((t) => t.toLowerCase());
  for (const term of lowered) {
    const set = TERM_TO_GROUP.get(term) ?? new Set<string>();
    for (const t of lowered) set.add(t);
    TERM_TO_GROUP.set(term, set);
  }
}

/**
 * Escapes SQLite LIKE metacharacters (`%`, `_`, and the escape character `\`
 * itself) in a term destined for a `LIKE '%term%' ESCAPE '\'` clause, so a
 * literal `%` or `_` in a search query can't turn into an unintended wildcard.
 * Escape the backslash FIRST — escaping it after `%`/`_` would double-escape
 * the backslashes just inserted.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Expands already-tokenized, lower-cased search terms into a superset of the
 * literal terms plus curated synonyms. `expandedTerms` always contains every
 * entry of `terms` — literal matching is preserved, expansion only adds recall.
 *
 * Multi-word synonym entries ("t shirt", "first edition") are matched by also
 * checking adjacent-term bigrams, so a multi-word query expands correctly even
 * though callers pass already-split single-word terms.
 */
export function expandQuery(terms: string[]): string[] {
  const literalTerms = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (literalTerms.length === 0) return [];

  const candidates = new Set<string>(literalTerms);
  for (let i = 0; i < literalTerms.length - 1; i++) {
    candidates.add(`${literalTerms[i]} ${literalTerms[i + 1]}`);
  }

  const expandedTerms = new Set<string>(literalTerms);
  for (const candidate of candidates) {
    const group = TERM_TO_GROUP.get(candidate);
    if (group) for (const t of group) expandedTerms.add(t);
  }

  return [...expandedTerms];
}
