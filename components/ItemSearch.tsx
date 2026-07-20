'use client';

import { useEffect, useState } from 'react';
import { CATEGORIES, conditionsForCategory, type Category } from '@/lib/constants';

// 300ms is the standard sweet spot for search-input debouncing: long enough
// to skip a fetch per keystroke while typing, short enough that results
// still feel responsive once the user pauses.
const SEARCH_DEBOUNCE_MS = 300;

const STATUSES = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'] as const;

const CATEGORY_LABELS: Record<Category, string> = {
  book: 'Book',
  clothing: 'Clothing',
  electronics: 'Electronics',
};

export interface ItemFilters {
  q: string;
  category: string;
  condition: string;
  status: string;
}

const DEFAULT_FILTERS: ItemFilters = { q: '', category: '', condition: '', status: '' };

interface ItemSearchProps {
  filters: ItemFilters;
  onChange: (filters: ItemFilters) => void;
}

export default function ItemSearch({ filters, onChange }: ItemSearchProps) {
  // Local state for the text input so keystrokes render instantly, while
  // the upstream onChange (which drives an API fetch) is debounced —
  // otherwise every keystroke would trigger its own request.
  const [qInput, setQInput] = useState(filters.q);

  // Keep local state in sync with external filter changes (the Clear
  // button, or any other parent-driven reset). A no-op once our own
  // debounced update below has already made qInput === filters.q.
  useEffect(() => {
    setQInput(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (qInput === filters.q) return;
    const timer = setTimeout(() => {
      onChange({ ...filters, q: qInput });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput, filters, onChange]);

  function update(patch: Partial<ItemFilters>) {
    onChange({ ...filters, ...patch });
  }

  function handleCategoryChange(next: string) {
    // Condition vocabularies are category-specific and don't overlap
    // (BOOK_CONDITIONS vs CLOTHING_CONDITIONS in lib/constants), so a
    // condition value only makes sense once a category is chosen. Rather
    // than unioning both vocabularies for the "all categories" case, the
    // condition select is disabled until a category is picked, and any
    // previously-chosen condition is cleared on category change. This
    // mirrors GET /api/items, which only validates `condition` against a
    // specific vocabulary when `category` is supplied alongside it.
    update({ category: next, condition: '' });
  }

  const conditionOptions = filters.category
    ? conditionsForCategory(filters.category as Category)
    : [];

  return (
    <div className="flex flex-wrap gap-3 mb-4">
      <input
        type="text"
        placeholder="Search title or author…"
        value={qInput}
        onChange={e => setQInput(e.target.value)}
        className="border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm flex-1 min-w-48 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
      />
      <select
        value={filters.category}
        onChange={e => handleCategoryChange(e.target.value)}
        className="border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm dark:bg-gray-800 dark:text-gray-100"
      >
        <option value="">All Categories</option>
        {CATEGORIES.map(c => (
          <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
        ))}
      </select>
      <select
        value={filters.condition}
        onChange={e => update({ condition: e.target.value })}
        disabled={!filters.category}
        title={!filters.category ? 'Select a category first' : undefined}
        className="border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm dark:bg-gray-800 dark:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">{filters.category ? 'All Conditions' : 'Select a category first'}</option>
        {conditionOptions.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select
        value={filters.status}
        onChange={e => update({ status: e.target.value })}
        className="border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm dark:bg-gray-800 dark:text-gray-100"
      >
        <option value="">All Statuses</option>
        {STATUSES.map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <button
        onClick={() => {
          // Reset local state directly rather than relying on the
          // filters.q-sync effect: if the debounce timer hadn't fired yet,
          // filters.q in the parent may still equal '' from before the user
          // even started typing — a value-based prop diff would see no
          // change and leave qInput (and the pending timer) stale.
          setQInput('');
          onChange(DEFAULT_FILTERS);
        }}
        className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-600 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 dark:bg-gray-800"
      >
        Clear
      </button>
    </div>
  );
}
