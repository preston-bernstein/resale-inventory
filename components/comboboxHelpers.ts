// Shared pure-function logic behind BrandCombobox and VocabCombobox — both
// hand-rolled ARIA comboboxes filter/rank/highlight canonical (id +
// canonical_name) items identically; only the data source and "add new"
// label text differ between them. Extracted here once both components had
// converged on byte-identical implementations (fallow's duplicate-exports
// check flagged the clone), rather than left as two independently
// maintained copies.

export interface CanonicalItem {
  id: string;
  canonical_name: string;
}

export interface ComboOption {
  key: string;
  label: string;
  value: string;
  isAddNew: boolean;
}

/**
 * Sort canonical items that already passed the substring filter so that
 * ones matching earlier in the operator's frequency-sorted history come
 * first; unmatched items fall back to alphabetical order among themselves.
 */
export function rankByFrequency<T extends CanonicalItem>(filtered: T[], frequency: string[]): T[] {
  const freqRank = new Map<string, number>();
  frequency.forEach((f, i) => {
    const key = f.toLowerCase();
    if (!freqRank.has(key)) freqRank.set(key, i);
  });

  return [...filtered].sort((a, b) => {
    const aIdx = freqRank.get(a.canonical_name.toLowerCase());
    const bIdx = freqRank.get(b.canonical_name.toLowerCase());
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    return a.canonical_name.localeCompare(b.canonical_name);
  });
}

/** Clamp a highlighted-option index one step up or down within bounds. */
export function moveHighlightIndex(
  current: number,
  direction: 'up' | 'down',
  optionCount: number
): number {
  if (optionCount === 0) return -1;
  return direction === 'down'
    ? Math.min(current + 1, optionCount - 1)
    : Math.max(current - 1, 0);
}

/**
 * Build the listbox options from the already-ranked canonical matches, plus
 * a trailing "Add new {label}" option when the typed value has no exact
 * (case-insensitive) canonical match.
 */
export function buildComboOptions<T extends CanonicalItem>(
  ranked: T[],
  trimmedValue: string,
  hasExactMatch: boolean,
  label: string
): ComboOption[] {
  const options: ComboOption[] = ranked.map(item => ({
    key: item.id,
    label: item.canonical_name,
    value: item.canonical_name,
    isAddNew: false,
  }));

  if (trimmedValue.length > 0 && !hasExactMatch) {
    options.push({
      key: '__add-new__',
      label: `Add "${trimmedValue}" as a new ${label}`,
      value: trimmedValue,
      isAddNew: true,
    });
  }

  return options;
}
