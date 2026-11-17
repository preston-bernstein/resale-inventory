'use client';

import { useId, type ChangeEvent, type FocusEvent } from 'react';
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
} from './comboboxOptions';
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

// Filtering, ranking and ARIA wiring for one combobox instance. Returns the
// input's attributes and handlers as one object so the component only lays
// out markup.
function useVocabCombobox(props: VocabComboboxProps, listboxId: string) {
  const { value, onChange, endpoint, responseKey, suggestionField, label, required = false } = props;

  const { items, frequency } = useVocabItems(endpoint, responseKey, suggestionField);

  const trimmedValue = value.trim();
  const lowerValue = trimmedValue.toLowerCase();

  const filtered = items.filter(item => item.canonical_name.toLowerCase().includes(lowerValue));
  const ranked = rankByFrequency(filtered, frequency);

  const hasExactMatch = hasExactCanonicalMatch(items, trimmedValue);
  const options = buildComboOptions(ranked, trimmedValue, hasExactMatch, label);

  const { open, setOpen, highlightedIndex, setHighlightedIndex, selectOption, handleKeyDown } =
    useComboboxNavigation(options, onChange);

  const inputProps = {
    type: 'text',
    role: 'combobox',
    'aria-expanded': open,
    'aria-controls': computeAriaControls(open, options.length, listboxId),
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': computeActiveDescendant(open, highlightedIndex, listboxId),
    autoComplete: 'off',
    required,
    value,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
      setOpen(true);
      setHighlightedIndex(-1);
    },
    onFocus: () => setOpen(true),
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      onChange(e.target.value);
      setOpen(false);
    },
    onKeyDown: handleKeyDown,
  };

  return {
    inputProps,
    options,
    highlightedIndex,
    setHighlightedIndex,
    selectOption,
    showListbox: shouldShowListbox(open, options.length),
  };
}

export function VocabCombobox(props: VocabComboboxProps) {
  const { value, error, label, required = false, maxLength } = props;
  const inputId = useId();
  const listboxId = useId();
  const combobox = useVocabCombobox(props, listboxId);

  const showLengthHint = value.length > maxLength;

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {formatFieldLabel(label, required)}
      </label>
      <div className="relative">
        <input
          id={inputId}
          {...combobox.inputProps}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        {combobox.showListbox && (
          <ComboboxListbox
            listboxId={listboxId}
            options={combobox.options}
            highlightedIndex={combobox.highlightedIndex}
            onSelect={combobox.selectOption}
            onHighlight={combobox.setHighlightedIndex}
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
