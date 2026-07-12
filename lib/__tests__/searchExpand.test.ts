import { describe, it, expect } from 'vitest';
import { escapeLike, expandQuery } from '@/lib/searchExpand';

describe('escapeLike', () => {
  it('escapes % so it is not treated as a wildcard', () => {
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('escapes _ so it is not treated as a single-char wildcard', () => {
    expect(escapeLike('foo_bar')).toBe('foo\\_bar');
  });

  it('escapes a literal backslash before escaping % and _ (no double-escaping)', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeLike('denim jacket')).toBe('denim jacket');
  });
});

describe('expandQuery', () => {
  it('returns empty array for empty/whitespace-only input', () => {
    expect(expandQuery([])).toEqual([]);
    expect(expandQuery(['   '])).toEqual([]);
  });

  it('always includes the literal lower-cased terms', () => {
    const result = expandQuery(['Gatsby']);
    expect(result).toContain('gatsby');
  });

  it('expands a known synonym to its whole group', () => {
    const result = expandQuery(['jacket']);
    expect(result).toContain('jacket');
    expect(result).toContain('coat');
    expect(result).toContain('blazer');
  });

  it('expands a term with no known synonyms to just itself', () => {
    const result = expandQuery(['gatsby']);
    expect(result).toEqual(['gatsby']);
  });

  it('expansion is symmetric within a group (either member expands to the other)', () => {
    expect(expandQuery(['coat'])).toContain('jacket');
    expect(expandQuery(['jacket'])).toContain('coat');
  });

  it('matches multi-word synonym entries via adjacent-term bigrams', () => {
    const result = expandQuery(['t', 'shirt']);
    expect(result).toContain('tee');
    expect(result).toContain('tshirt');
  });

  it('deduplicates terms shared across expansions', () => {
    const result = expandQuery(['jacket', 'coat']);
    expect(result.filter((t) => t === 'jacket')).toHaveLength(1);
  });

  it('trims and lower-cases input terms', () => {
    const result = expandQuery(['  Jacket  ']);
    expect(result).toContain('jacket');
    expect(result).not.toContain('  Jacket  ');
  });
});
