'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { FieldError } from './FieldError';

interface CanonicalBrand {
  id: string;
  canonical_name: string;
}

interface BrandComboboxProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

interface ComboOption {
  key: string;
  label: string;
  value: string;
  isAddNew: boolean;
}

// Advisory-only client-side bound — the server independently validates.
// Duplicated here (rather than importing from @/lib/brands) because that
// module pulls in better-sqlite3 via @/lib/db, a server-only native module
// that cannot be bundled into a 'use client' component.
const MAX_BRAND_LENGTH = 255;

/**
 * Sort canonical brands that already passed the substring filter so that
 * ones matching earlier in the operator's frequency-sorted history come
 * first; unmatched brands fall back to alphabetical order among themselves.
 * Extracted as a pure function so the ranking rule has its own unit tests
 * rather than only indirect coverage through the rendered component.
 */
export function rankByFrequency(
  filtered: CanonicalBrand[],
  frequency: string[]
): CanonicalBrand[] {
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
 * a trailing "Add new brand" option when the typed value has no exact
 * (case-insensitive) canonical match.
 */
export function buildComboOptions(
  ranked: CanonicalBrand[],
  trimmedValue: string,
  hasExactMatch: boolean
): ComboOption[] {
  const options: ComboOption[] = ranked.map(b => ({
    key: b.id,
    label: b.canonical_name,
    value: b.canonical_name,
    isAddNew: false,
  }));

  if (trimmedValue.length > 0 && !hasExactMatch) {
    options.push({
      key: '__add-new__',
      label: `Add "${trimmedValue}" as a new brand`,
      value: trimmedValue,
      isAddNew: true,
    });
  }

  return options;
}

/**
 * Hand-rolled ARIA combobox for the clothing form's brand field.
 *
 * Owns its own data fetching: the canonical brand list (GET /api/brands,
 * already alphabetical) and the operator's own historical brand entries
 * (fetchFieldSuggestions('brand'), frequency-sorted). The canonical list is
 * authoritative for which options exist; the frequency list is only a
 * ranking signal used to reorder the filtered canonical matches so
 * previously-used brands surface first.
 *
 * The raw typed value is committed to form state on every keystroke and on
 * blur, independent of any listbox selection — the dropdown is a browsing
 * aid layered on top of a fully-functional text input, not a gate. This
 * keeps existing `.fill()`-based e2e helpers working unchanged.
 */
export function BrandCombobox({ value, onChange, error }: BrandComboboxProps) {
  const [brands, setBrands] = useState<CanonicalBrand[]>([]);
  const [frequency, setFrequency] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputId = useId();
  const listboxId = useId();

  useEffect(() => {
    let cancelled = false;

    fetch('/api/brands')
      .then(res => (res.ok ? res.json() : { brands: [] }))
      .then((data: { brands?: CanonicalBrand[] }) => {
        if (!cancelled && Array.isArray(data.brands)) setBrands(data.brands);
      })
      .catch(() => {
        if (!cancelled) setBrands([]);
      });

    void fetchFieldSuggestions('brand').then(values => {
      if (!cancelled) setFrequency(values);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedValue = value.trim();
  const lowerValue = trimmedValue.toLowerCase();

  // Canonical list is authoritative for existence; substring-filter it.
  // Frequency list only supplies a ranking signal: earlier occurrence in
  // the operator's historical (frequency-sorted) brand values sorts a
  // canonical match earlier. See rankByFrequency for the tie-break rule.
  const filtered = brands.filter(b => b.canonical_name.toLowerCase().includes(lowerValue));
  const ranked = rankByFrequency(filtered, frequency);

  const hasExactMatch =
    trimmedValue.length > 0 && brands.some(b => b.canonical_name.toLowerCase() === lowerValue);
  const options = buildComboOptions(ranked, trimmedValue, hasExactMatch);

  function selectOption(optionValue: string) {
    onChange(optionValue);
    setOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        setOpen(true);
        setHighlightedIndex(i =>
          moveHighlightIndex(i, e.key === 'ArrowDown' ? 'down' : 'up', options.length)
        );
        return;
      case 'Enter':
        if (open && highlightedIndex >= 0 && highlightedIndex < options.length) {
          e.preventDefault();
          selectOption(options[highlightedIndex].value);
        } else {
          // No option highlighted — just confirm the current typed text
          // (already committed via onChange) and close the dropdown, letting
          // the keystroke fall through to its default behavior (form submit).
          setOpen(false);
        }
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        setOpen(false);
        setHighlightedIndex(-1);
        return;
    }
  }

  const showLengthHint = value.length > MAX_BRAND_LENGTH;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        Brand *
      </label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open && options.length > 0 ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined
          }
          autoComplete="off"
          required
          value={value}
          onChange={e => {
            onChange(e.target.value);
            setOpen(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={e => {
            // Raw typed value is already committed on every change; commit
            // once more on blur so leaving the field is never a no-op path.
            onChange(e.target.value);
            setOpen(false);
          }}
          onKeyDown={handleKeyDown}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        {open && options.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm shadow-lg"
          >
            {options.map((option, index) => (
              <li
                key={option.key}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={index === highlightedIndex}
                onMouseDown={e => e.preventDefault()}
                onClick={() => selectOption(option.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={[
                  'px-3 py-2 cursor-pointer',
                  option.isAddNew
                    ? 'italic text-blue-600 dark:text-blue-400'
                    : 'text-gray-900 dark:text-gray-100',
                  index === highlightedIndex ? 'bg-gray-100 dark:bg-gray-700' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {showLengthHint && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
          Brand name is longer than the 255-character limit.
        </p>
      )}
      <FieldError message={error} />
    </div>
  );
}
