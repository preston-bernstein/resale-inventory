'use client';

import type { ComboOption } from './comboboxHelpers';

interface ComboboxListboxProps {
  listboxId: string;
  options: ComboOption[];
  highlightedIndex: number;
  onSelect: (value: string) => void;
  onHighlight: (index: number) => void;
}

/**
 * The dropdown `<ul role="listbox">` shared by BrandCombobox/VocabCombobox
 * (via VocabCombobox — BrandCombobox is a thin wrapper over it). Extracted
 * out of VocabCombobox to keep that component's own cyclomatic/cognitive
 * complexity under fallow's threshold; this owns the per-option
 * highlight/isAddNew styling branches.
 */
export function ComboboxListbox({
  listboxId,
  options,
  highlightedIndex,
  onSelect,
  onHighlight,
}: ComboboxListboxProps) {
  return (
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
          onClick={() => onSelect(option.value)}
          onMouseEnter={() => onHighlight(index)}
          className={[
            'px-3 py-2 cursor-pointer',
            option.isAddNew ? 'italic text-blue-600 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100',
            index === highlightedIndex ? 'bg-gray-100 dark:bg-gray-700' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {option.label}
        </li>
      ))}
    </ul>
  );
}
