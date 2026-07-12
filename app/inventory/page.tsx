'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import ItemSearch, { type ItemFilters } from '@/components/ItemSearch';
import ItemCardGrid, { ItemCardGridSkeleton, type ItemRow } from '@/components/ItemCardGrid';

interface ItemsResponse {
  items: ItemRow[];
  total: number;
  page: number;
  limit: number;
}

const DEFAULT_FILTERS: ItemFilters = { q: '', category: '', condition: '', status: '' };
const LIMIT = 25;

export default function InventoryPage() {
  const [filters, setFilters] = useState<ItemFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ItemsResponse>({ items: [], total: 0, page: 0, limit: LIMIT });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async (f: ItemFilters, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (f.q) params.set('q', f.q);
      if (f.category) params.set('category', f.category);
      if (f.condition) params.set('condition', f.condition);
      if (f.status) params.set('status', f.status);
      params.set('page', String(p));
      params.set('limit', String(LIMIT));

      const res = await fetch(`/api/items?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ItemsResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems(filters, page);
  }, [filters, page, fetchItems]);

  function handleFiltersChange(next: ItemFilters) {
    setFilters(next);
    setPage(0);
  }

  function handlePageChange(next: number) {
    setPage(next);
  }

  const hasActiveFilters = Boolean(filters.q || filters.category || filters.condition || filters.status);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Inventory</h1>
        <Link
          href="/inventory/new"
          className="text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200"
        >
          Add Item
        </Link>
      </div>

      <ItemSearch filters={filters} onChange={handleFiltersChange} />

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
      )}

      {loading ? (
        <ItemCardGridSkeleton />
      ) : (
        <ItemCardGrid
          items={data.items}
          total={data.total}
          page={data.page}
          limit={data.limit}
          onPageChange={handlePageChange}
          hasActiveFilters={hasActiveFilters}
        />
      )}
    </div>
  );
}
