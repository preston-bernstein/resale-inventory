import { describe, it, expect } from 'vitest';
import * as brandCombobox from '../BrandCombobox';
import * as vocabCombobox from '../VocabCombobox';

// BrandCombobox and VocabCombobox both re-export the pure option logic from
// comboboxOptions.ts. Each case runs once per component, with that
// component's own sample names and "add new" label.
interface ComboboxModule {
  rankByFrequency: typeof brandCombobox.rankByFrequency;
  moveHighlightIndex: typeof brandCombobox.moveHighlightIndex;
  buildComboOptions: (
    ranked: { id: string; canonical_name: string }[],
    typed: string,
    hasExactMatch: boolean,
  ) => ReturnType<typeof brandCombobox.buildComboOptions>;
}

interface ComboboxCase {
  name: string;
  module: ComboboxModule;
  /** Sample names: `late` sorts after `early` alphabetically; `matched` is in the frequency list. */
  late: string;
  early: string;
  matched: string;
  /** Typed text that has no canonical match, and the noun in its "Add new" label. */
  unmatchedTyped: string;
  addNewNoun: string;
}

const CASES: ComboboxCase[] = [
  {
    name: 'BrandCombobox',
    module: brandCombobox,
    late: 'Zara',
    early: 'Adidas',
    matched: 'Nike',
    unmatchedTyped: 'Stussy',
    addNewNoun: 'brand',
  },
  {
    name: 'VocabCombobox',
    module: {
      rankByFrequency: vocabCombobox.rankByFrequency,
      moveHighlightIndex: vocabCombobox.moveHighlightIndex,
      buildComboOptions: (ranked, typed, hasExactMatch) =>
        vocabCombobox.buildComboOptions(ranked, typed, hasExactMatch, 'Color'),
    },
    late: 'Blue',
    early: 'Beige',
    matched: 'Black',
    unmatchedTyped: 'Lavender',
    addNewNoun: 'Color',
  },
];

const item = (id: string, name: string) => ({ id, canonical_name: name });
const names = (items: { canonical_name: string }[]) => items.map((i) => i.canonical_name);

describe.each(CASES)('rankByFrequency ($name)', ({ module, late, early, matched }) => {
  it('sorts items matching the frequency list earlier, in frequency order', () => {
    const filtered = [item('1', late), item('2', matched), item('3', early)];
    const result = module.rankByFrequency(filtered, [matched.toLowerCase(), late.toLowerCase()]);
    expect(names(result)).toEqual([matched, late, early]);
  });

  it('sorts unmatched items alphabetically after matched ones', () => {
    const filtered = [item('1', late), item('2', early), item('3', matched)];
    const result = module.rankByFrequency(filtered, [matched.toLowerCase()]);
    expect(names(result)).toEqual([matched, early, late]);
  });

  it('is case-insensitive when matching against the frequency list', () => {
    const result = module.rankByFrequency([item('1', matched)], [matched.toUpperCase()]);
    expect(names(result)).toEqual([matched]);
  });

  it('with an empty frequency list, falls back to pure alphabetical order', () => {
    const result = module.rankByFrequency([item('1', late), item('2', early)], []);
    expect(names(result)).toEqual([early, late]);
  });

  it('with an empty filtered list, returns an empty list', () => {
    expect(module.rankByFrequency([], [matched.toLowerCase()])).toEqual([]);
  });
});

describe.each(CASES)('buildComboOptions ($name)', ({ module, early, matched, unmatchedTyped, addNewNoun }) => {
  it('maps each ranked item to a non-add-new option in order', () => {
    const ranked = [item('1', early), item('2', matched)];
    const options = module.buildComboOptions(ranked, matched.slice(0, 3).toLowerCase(), true);
    expect(options).toEqual([
      { key: '1', label: early, value: early, isAddNew: false },
      { key: '2', label: matched, value: matched, isAddNew: false },
    ]);
  });

  it('appends an "Add new" option when there is no exact match and typed text is non-empty', () => {
    const options = module.buildComboOptions([], unmatchedTyped, false);
    expect(options).toEqual([
      {
        key: '__add-new__',
        label: `Add "${unmatchedTyped}" as a new ${addNewNoun}`,
        value: unmatchedTyped,
        isAddNew: true,
      },
    ]);
  });

  it('omits the "Add new" option when there is an exact match', () => {
    const options = module.buildComboOptions([item('1', matched)], matched, true);
    expect(options).toEqual([{ key: '1', label: matched, value: matched, isAddNew: false }]);
  });

  it('omits the "Add new" option when the typed value is empty', () => {
    expect(module.buildComboOptions([], '', false)).toEqual([]);
  });
});

describe.each(CASES)('moveHighlightIndex ($name)', ({ module }) => {
  const { moveHighlightIndex } = module;

  it('moving down from -1 (nothing highlighted) lands on index 0', () => {
    expect(moveHighlightIndex(-1, 'down', 3)).toBe(0);
  });

  it('moving down stops at the last index (no wraparound)', () => {
    expect(moveHighlightIndex(2, 'down', 3)).toBe(2);
  });

  it('moving up from index 0 stays at 0 (no wraparound)', () => {
    expect(moveHighlightIndex(0, 'up', 3)).toBe(0);
  });

  it('moving up from index 2 lands on index 1', () => {
    expect(moveHighlightIndex(2, 'up', 3)).toBe(1);
  });

  it('with zero options, always returns -1 regardless of direction', () => {
    expect(moveHighlightIndex(-1, 'down', 0)).toBe(-1);
    expect(moveHighlightIndex(-1, 'up', 0)).toBe(-1);
  });
});
