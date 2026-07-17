import { useEffect, useState, type KeyboardEvent } from 'react';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { moveHighlightIndex, type CanonicalItem, type ComboOption } from './comboboxHelpers';

/**
 * Fetches the canonical vocabulary list (GET {endpoint}) plus the operator's
 * frequency-ranking history (fetchFieldSuggestions) for one VocabCombobox
 * instance. Extracted out of VocabCombobox itself to keep that component's
 * own cyclomatic/cognitive complexity under fallow's threshold — this hook
 * owns the two async fetches and their cancellation-on-unmount guard.
 */
export function useVocabItems(endpoint: string, responseKey: string, suggestionField: string) {
  const [items, setItems] = useState<CanonicalItem[]>([]);
  const [frequency, setFrequency] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch(endpoint)
      .then(res => (res.ok ? res.json() : { [responseKey]: [] }))
      .then((data: Record<string, CanonicalItem[] | undefined>) => {
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

  return { items, frequency };
}

/**
 * Open/highlight state plus ARIA keyboard handling (ArrowUp/Down, Enter,
 * Escape) shared by the combobox listbox. Extracted alongside useVocabItems
 * for the same complexity-budget reason — this owns the switch-heavy
 * keydown handler so VocabCombobox's own body stays render/filter logic
 * only.
 */
export function useComboboxNavigation(options: ComboOption[], onChange: (value: string) => void) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

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

  return { open, setOpen, highlightedIndex, setHighlightedIndex, selectOption, handleKeyDown };
}
