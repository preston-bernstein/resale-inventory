'use client';

import Link from 'next/link';
import type { Item } from '@/lib/types';

export type ItemRow = Item & { platforms: string[] };

interface ItemTableProps {
  items: ItemRow[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
}

function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCategory(category: Item['category']): string {
  return category === 'book' ? 'Book' : 'Clothing';
}

export default function ItemTable({ items, total, page, limit, onPageChange }: ItemTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = total === 0 ? 0 : page * limit + 1;
  const end = Math.min(page * limit + items.length, total);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Title</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Category</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Condition</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Status</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Listing Price</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Platforms</th>
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                  No items found.
                </td>
              </tr>
            ) : (
              items.map(item => (
                <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">{item.title}</td>
                  <td className="px-3 py-2">{formatCategory(item.category)}</td>
                  <td className="px-3 py-2">{item.details.condition}</td>
                  <td className="px-3 py-2">{item.status}</td>
                  <td className="px-3 py-2">{formatCents(item.listing_price)}</td>
                  <td className="px-3 py-2">
                    {item.platforms && item.platforms.length > 0 ? item.platforms.join(', ') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/inventory/${item.id}`}
                      className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-100"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-sm text-gray-600">
        <span>
          {total === 0
            ? 'No results'
            : `Showing ${start}–${end} of ${total}`}
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
            className="px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span>Page {page + 1} of {totalPages}</span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
