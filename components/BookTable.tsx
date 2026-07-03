'use client';

import Link from 'next/link';

export interface Book {
  id: string;
  isbn: string | null;
  title: string;
  author: string;
  condition: string;
  status: string;
  listing_price: number | null;
  platforms: string[];
  acquisition_cost: number;
  sale_price: number | null;
  sale_date: string | null;
  gross_profit: number | null;
}

interface BookTableProps {
  items: Book[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
}

function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export default function BookTable({ items, total, page, limit, onPageChange }: BookTableProps) {
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
              <th className="text-left px-3 py-2 font-medium text-gray-700 border-b border-gray-200">Author</th>
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
                  No books found.
                </td>
              </tr>
            ) : (
              items.map(book => (
                <tr key={book.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2">{book.title}</td>
                  <td className="px-3 py-2">{book.author}</td>
                  <td className="px-3 py-2">{book.condition}</td>
                  <td className="px-3 py-2">{book.status}</td>
                  <td className="px-3 py-2">{formatCents(book.listing_price)}</td>
                  <td className="px-3 py-2">
                    {book.platforms.length > 0 ? book.platforms.join(', ') : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/books/${book.id}`}
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
