'use client';

import { CATEGORIES, conditionsForCategory, type Category } from '@/lib/constants';

const STATUSES = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'] as const;

const CATEGORY_LABELS: Record<Category, string> = {
  book: 'Book',
  clothing: 'Clothing',
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
        value={filters.q}
        onChange={e => update({ q: e.target.value })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-48"
      />
      <select
        value={filters.category}
        onChange={e => handleCategoryChange(e.target.value)}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm"
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
        className="border border-gray-300 rounded px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">{filters.category ? 'All Conditions' : 'Select a category first'}</option>
        {conditionOptions.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select
        value={filters.status}
        onChange={e => update({ status: e.target.value })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm"
      >
        <option value="">All Statuses</option>
        {STATUSES.map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <button
        onClick={() => onChange(DEFAULT_FILTERS)}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
      >
        Clear
      </button>
    </div>
  );
}
