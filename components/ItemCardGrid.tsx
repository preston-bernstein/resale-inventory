'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { Item } from '@/lib/types';

export type ItemRow = Item & { platforms: string[]; cover_photo_id: string | null };

interface ItemCardGridProps {
  items: ItemRow[];
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
  /** Distinguishes "no items exist yet" (first-run) from "filters matched nothing" — different empty states. */
  hasActiveFilters?: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  Unlisted: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  Listed: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300',
  'Sale Pending': 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  Sold: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  Removed: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  Donated: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  Discarded: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

const CATEGORY_STYLES: Record<Item['category'], string> = {
  book: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300',
  clothing: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300',
};

// Deterministic per-item placeholder tint (items without a cover photo)
// so the grid still reads as varied/alive rather than a wall of identical
// gray boxes — cycles through a small fixed palette keyed off item id.
const PLACEHOLDER_PALETTE = [
  'bg-rose-50 dark:bg-rose-950/40',
  'bg-amber-50 dark:bg-amber-950/40',
  'bg-emerald-50 dark:bg-emerald-950/40',
  'bg-sky-50 dark:bg-sky-950/40',
  'bg-violet-50 dark:bg-violet-950/40',
  'bg-indigo-50 dark:bg-indigo-950/40',
];

function placeholderTint(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PLACEHOLDER_PALETTE[hash % PLACEHOLDER_PALETTE.length];
}

function formatCents(cents: number | null): string {
  if (cents === null) return 'Unpriced';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCategory(category: Item['category']): string {
  return category === 'book' ? 'Book' : 'Clothing';
}

/** Skeleton placeholder shown while the list is loading — same card shape as the real grid, so nothing shifts when data arrives. */
export function ItemCardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 animate-pulse motion-reduce:animate-none"
        >
          <div className="w-full aspect-[4/5] bg-gray-200 dark:bg-gray-700" />
          <div className="p-2.5 space-y-2">
            <div className="h-3.5 bg-gray-200 dark:bg-gray-700 rounded w-4/5" />
            <div className="flex items-center justify-between">
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ItemCardGrid({ items, total, page, limit, onPageChange, hasActiveFilters }: ItemCardGridProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = total === 0 ? 0 : page * limit + 1;
  const end = Math.min(page * limit + items.length, total);

  return (
    <div>
      {items.length === 0 ? (
        hasActiveFilters ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-12">
            No items match your filters.
          </p>
        ) : (
          <div className="text-center py-12">
            <p className="text-3xl mb-2" aria-hidden="true">📦</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              No items yet — add your first book or clothing item to get started.
            </p>
            <Link
              href="/inventory/new"
              className="inline-block text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200"
            >
              Add Item
            </Link>
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {items.map((item) => (
            <Link
              key={item.id}
              href={`/inventory/${item.id}`}
              className="group border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 hover:shadow-md dark:hover:shadow-black/30 hover:border-gray-300 dark:hover:border-gray-600 transition-all motion-reduce:transition-none"
            >
              <div className={`relative w-full aspect-[4/5] ${item.cover_photo_id ? 'bg-gray-50 dark:bg-gray-900' : placeholderTint(item.id)}`}>
                {item.cover_photo_id ? (
                  <Image
                    src={`/api/items/${item.id}/photos/${item.cover_photo_id}`}
                    alt=""
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    className="object-cover transition-transform group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-3xl opacity-40" aria-hidden="true">
                      {item.category === 'book' ? '📖' : '👕'}
                    </span>
                  </div>
                )}
                <span
                  className={`absolute top-2 left-2 text-[10px] font-medium px-1.5 py-0.5 rounded ${CATEGORY_STYLES[item.category]}`}
                >
                  {formatCategory(item.category)}
                </span>
                <span
                  className={`absolute top-2 right-2 text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_STYLES[item.status] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}
                >
                  {item.status}
                </span>
              </div>
              <div className="p-2.5">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-snug">{item.title}</p>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{item.details.condition}</span>
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{formatCents(item.listing_price)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mt-4 text-sm text-gray-600 dark:text-gray-400">
        <span>
          {total === 0
            ? 'No results'
            : `Showing ${start}–${end} of ${total}`}
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span>Page {page + 1} of {totalPages}</span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
