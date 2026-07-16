import type { BookDetails, ClothingDetails } from '@/lib/types';
import type { ListingInput } from './types';

/**
 * Builds a plain-text listing description from category-specific details.
 * Shared verbatim across all 8 connectors -- every platform's create/update
 * flow needs the same category-detail-to-text mapping, only the field it
 * gets posted into differs per platform.
 */
export function buildListingDescription(input: Pick<ListingInput, 'category' | 'details'>): string {
  if (input.category === 'book') {
    const d = input.details as BookDetails;
    return [
      d.author ? `By ${d.author}` : null,
      d.publisher ? `Publisher: ${d.publisher}` : null,
      d.isbn ? `ISBN: ${d.isbn}` : null,
      `Condition: ${d.condition}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = input.details as ClothingDetails;
  return [
    d.brand ? `Brand: ${d.brand}` : null,
    d.size_label ? `Size: ${d.size_label}` : null,
    d.color ? `Color: ${d.color}` : null,
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Converts integer cents to a "12.34"-style dollar string for platform form fills/payloads. */
export function formatPriceDollars(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}
