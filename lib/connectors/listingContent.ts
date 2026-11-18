import type { BookDetails, ClothingDetails, ElectronicsDetails } from '@/lib/types';
import type { ListingInput } from './types';

function buildBookDescription(d: BookDetails): string {
  return [
    d.author ? `By ${d.author}` : null,
    d.publisher ? `Publisher: ${d.publisher}` : null,
    d.isbn ? `ISBN: ${d.isbn}` : null,
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildClothingDescription(d: ClothingDetails): string {
  return [
    d.brand ? `Brand: ${d.brand}` : null,
    d.size_label ? `Size: ${d.size_label}` : null,
    d.color ? `Color: ${d.color}` : null,
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function textLine(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

// `!= null` (not truthy) checks throughout -- battery_health_pct (0-100) and
// battery_cycle_count (>=0) are both legitimately 0 (a brand new, zero-cycle
// battery; a fully depleted one), and a truthy check would silently drop
// those rows from the description. ram_gb/storage_gb/screen_size_in can't be
// 0 per lib/electronics.ts's validators, but checking the same way keeps
// this block one consistent pattern rather than a mix of `?:` and `!= null`.
function numberLine(label: string, value: number | null | undefined, unit = ''): string | null {
  return value != null ? `${label}: ${value}${unit}` : null;
}

function buildElectronicsDescription(d: ElectronicsDetails): string {
  return [
    textLine('Brand', d.brand),
    textLine('Model', d.model),
    textLine('Processor', d.processor),
    numberLine('RAM', d.ram_gb, 'GB'),
    numberLine('Storage', d.storage_gb, 'GB'),
    numberLine('Screen', d.screen_size_in, '"'),
    numberLine('Battery Health', d.battery_health_pct, '%'),
    numberLine('Battery Cycles', d.battery_cycle_count),
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Builds a plain-text listing description from category-specific details.
 * Shared verbatim across all 8 connectors -- every platform's create/update
 * flow needs the same category-detail-to-text mapping, only the field it
 * gets posted into differs per platform.
 */
export function buildListingDescription(input: Pick<ListingInput, 'category' | 'details'>): string {
  switch (input.category) {
    case 'book':
      return buildBookDescription(input.details as BookDetails);
    case 'clothing':
      return buildClothingDescription(input.details as ClothingDetails);
    case 'electronics':
      return buildElectronicsDescription(input.details as ElectronicsDetails);
    default: {
      const _exhaustive: never = input.category;
      throw new Error(`Unknown category: ${_exhaustive}`);
    }
  }
}

/** Converts integer cents to a "12.34"-style dollar string for platform form fills/payloads. */
export function formatPriceDollars(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}
