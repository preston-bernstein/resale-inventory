'use client';

import { CONDITIONS } from '@/lib/constants';

const STATUSES = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'] as const;

export interface BookFilters {
  q: string;
  isbn: string;
  condition: string;
  status: string;
}

interface BookSearchProps {
  filters: BookFilters;
  onChange: (filters: BookFilters) => void;
}

export default function BookSearch({ filters, onChange }: BookSearchProps) {
  function update(patch: Partial<BookFilters>) {
    onChange({ ...filters, ...patch });
  }

  return (
    <div className="flex flex-wrap gap-3 mb-4">
      <input
        type="text"
        placeholder="Search title or author…"
        value={filters.q}
        onChange={e => update({ q: e.target.value })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 min-w-48"
      />
      <input
        type="text"
        placeholder="ISBN"
        value={filters.isbn}
        onChange={e => update({ isbn: e.target.value })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40"
      />
      <select
        value={filters.condition}
        onChange={e => update({ condition: e.target.value })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm"
      >
        <option value="">All Conditions</option>
        {CONDITIONS.map(c => (
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
        onClick={() => onChange({ q: '', isbn: '', condition: '', status: '' })}
        className="border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
      >
        Clear
      </button>
    </div>
  );
}
