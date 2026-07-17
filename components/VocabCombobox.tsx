'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { FieldError } from './FieldError';
import {
  rankByFrequency,
  moveHighlightIndex,
  buildComboOptions,
  type CanonicalItem,
} from './comboboxHelpers';

type CanonicalVocabItem = CanonicalItem;

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
  const [items, setItems] = useState<CanonicalVocabItem[]>([]);
  const [frequency, setFrequency] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputId = useId();
  const listboxId = useId();

  useEffect(() => {
    let cancelled = false;

    fetch(endpoint)
      .then(res => (res.ok ? res.json() : { [responseKey]: [] }))
      .then((data: Record<string, CanonicalVocabItem[] | undefined>) => {
        const list = data[responseKey];
        if (!cancelled && Array.isArray(list)) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });

    void fetchFieldSuggestions(suggestionField).then(values => {
      if (!cancelled) setFrequency(values);
    });

    return () => {
      cancelled = true;
    };
  }, [endpoint, responseKey, suggestionField]);

  const trimmedValue = value.trim();
  const lowerValue = trimmedValue.toLowerCase();

  const filtered = items.filter(item => item.canonical_name.toLowerCase().includes(lowerValue));
  const ranked = rankByFrequency(filtered, frequency);

  const hasExactMatch =
    trimmedValue.length > 0 && items.some(item => item.canonical_name.toLowerCase() === lowerValue);
  const options = buildComboOptions(ranked, trimmedValue, hasExactMatch, label);

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

  const showLengthHint = value.length > maxLength;

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
        {required ? ' *' : ''}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open && options.length > 0 ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined}
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
                  option.isAddNew ? 'italic text-blue-600 dark:text-blue-400' : 'text-gray-900 dark:text-gray-100',
                  index === highlightedIndex ? 'bg-gray-100 dark:bg-gray-700' : '',
                ].filter(Boolean).join(' ')}
              >
                {option.label}
              </li>
            ))}
          </ul>
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
