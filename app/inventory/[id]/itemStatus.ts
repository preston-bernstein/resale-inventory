import type { ItemWithRelations, Photo } from '@/lib/types';

const TERMINAL_STATUSES = new Set(['Sold', 'Removed', 'Donated', 'Discarded']);

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  Unlisted: ['Listed', 'Donated', 'Discarded'],
  Listed: ['Unlisted', 'Sale Pending', 'Removed', 'Donated', 'Discarded'],
  'Sale Pending': ['Listed', 'Sold'],
};

export const SALE_PLATFORMS = ['eBay', 'Amazon', 'ThriftBooks', 'AbeBooks', 'Facebook Marketplace', 'Other'];

export interface DerivedItemView {
  isTerminal: boolean;
  transitions: string[];
  grossProfit: number | null;
  heroPhoto: Photo | null;
}

// Pure derivation of the view-only values computed from `item` — split out
// so ItemDetailPage's own body doesn't carry this branching.
export function deriveItemView(item: ItemWithRelations): DerivedItemView {
  const isTerminal = TERMINAL_STATUSES.has(item.status);
  const transitions = STATUS_TRANSITIONS[item.status] ?? [];
  const grossProfit =
    item.status === 'Sold' && item.sale_price !== null ? item.sale_price - item.acquisition_cost : null;
  const heroPhoto =
    item.category === 'clothing' && item.photos.length > 0
      ? [...item.photos].sort((a, b) => a.sort_order - b.sort_order)[0]
      : null;
  return { isTerminal, transitions, grossProfit, heroPhoto };
}
