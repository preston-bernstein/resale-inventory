'use client';

import { useId } from 'react';
import { FieldError } from './FieldError';
import { ComboboxListbox } from './ComboboxListbox';
import {
  rankByFrequency,
  moveHighlightIndex,
  buildComboOptions,
  hasExactCanonicalMatch,
  formatFieldLabel,
  computeAriaControls,
  computeActiveDescendant,
  shouldShowListbox,
} from './comboboxHelpers';
import { useVocabItems, useComboboxNavigation } from './useVocabCombobox';

interface VocabComboboxProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  endpoint: string; // e.g. '/api/colors'
  responseKey: string; // e.g. 'colors' — matches the endpoint's JSON key
  suggestionField: string; // fetchFieldSuggestions field key, e.g. 'color'
  label: string; // e.g. 'Color'
  required?: boolean; // default false
  maxLength: number; // e.g. 255
}

export { rankByFrequency, moveHighlightIndex, buildComboOptions };

export function VocabCombobox({
  value,
  onChange,
  error,
  endpoint,
  responseKey,
  suggestionField,
  label,
  required = false,
  maxLength,
}: VocabComboboxProps) {
  const inputId = useId();
  const listboxId = useId();

  const { items, frequency } = useVocabItems(endpoint, responseKey, suggestionField);

  const trimmedValue = value.trim();
  const lowerValue = trimmedValue.toLowerCase();

  const filtered = items.filter(item => item.canonical_name.toLowerCase().includes(lowerValue));
  const ranked = rankByFrequency(filtered, frequency);

  const hasExactMatch = hasExactCanonicalMatch(items, trimmedValue);
  const options = buildComboOptions(ranked, trimmedValue, hasExactMatch, label);

  const { open, setOpen, highlightedIndex, setHighlightedIndex, selectOption, handleKeyDown } =
    useComboboxNavigation(options, onChange);

  const showLengthHint = value.length > maxLength;
  const fieldLabel = formatFieldLabel(label, required);
  const ariaControls = computeAriaControls(open, options.length, listboxId);
  const ariaActiveDescendant = computeActiveDescendant(open, highlightedIndex, listboxId);
  const showListbox = shouldShowListbox(open, options.length);

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {fieldLabel}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={ariaControls}
          aria-autocomplete="list"
          aria-activedescendant={ariaActiveDescendant}
          autoComplete="off"
          required={required}
          value={value}
          onChange={e => {
            onChange(e.target.value);
            setOpen(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={e => {
            onChange(e.target.value);
            setOpen(false);
          }}
          onKeyDown={handleKeyDown}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        {showListbox && (
          <ComboboxListbox
            listboxId={listboxId}
            options={options}
            highlightedIndex={highlightedIndex}
            onSelect={selectOption}
            onHighlight={setHighlightedIndex}
          />
        )}
      </div>
      {showLengthHint && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
          {label} is longer than the {maxLength}-character limit.
        </p>
      )}
      <FieldError message={error} />
    </div>
  );
}
