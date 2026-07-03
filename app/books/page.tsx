'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import BookSearch, { type BookFilters } from '@/components/BookSearch';
import BookTable, { type Book } from '@/components/BookTable';

interface BooksResponse {
  items: Book[];
  total: number;
  page: number;
  limit: number;
}

const DEFAULT_FILTERS: BookFilters = { q: '', isbn: '', condition: '', status: '' };
const LIMIT = 25;

export default function BooksPage() {
  const [filters, setFilters] = useState<BookFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<BooksResponse>({ items: [], total: 0, page: 0, limit: LIMIT });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBooks = useCallback(async (f: BookFilters, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.q) params.set('q', f.q);
      if (f.isbn) params.set('isbn', f.isbn);
      if (f.condition) params.set('condition', f.condition);
      if (f.status) params.set('status', f.status);
      params.set('page', String(p));
      params.set('limit', String(LIMIT));

      const res = await fetch(`/api/books?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: BooksResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load books.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBooks(filters, page);
  }, [filters, page, fetchBooks]);

  function handleFiltersChange(next: BookFilters) {
    setFilters(next);
    setPage(0);
  }

  function handlePageChange(next: number) {
    setPage(next);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-gray-900">Books</h1>
        <Link
          href="/books/add"
          className="text-sm px-3 py-1.5 bg-gray-900 text-white rounded hover:bg-gray-700"
        >
          Add Book
        </Link>
      </div>

      <BookSearch filters={filters} onChange={handleFiltersChange} />

      {error && (
        <p className="text-sm text-red-600 mb-3">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>
      ) : (
        <BookTable
          items={data.items}
          total={data.total}
          page={data.page}
          limit={data.limit}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  );
}
