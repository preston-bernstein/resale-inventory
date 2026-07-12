import type { BookCondition, ClothingCondition } from './constants';

// Not exported: nothing outside this file references the status literal
// union by name — consumers type against `Item`/`ItemWithRelations`
// directly, which is where this is actually used.
type Status =
  | 'Unlisted'
  | 'Listed'
  | 'Sale Pending'
  | 'Sold'
  | 'Removed'
  | 'Donated'
  | 'Discarded';

export interface BookDetails {
  isbn: string | null;
  author: string;
  publisher: string | null;
  condition: BookCondition;
}

export interface ClothingDetails {
  brand: string;
  size_label: string;
  color: string | null;
  material: string | null;
  gender_department: string | null;
  weight_oz: number | null;
  pit_to_pit_in: number | null;
  length_in: number | null;
  sleeve_length_in: number | null;
  waist_in: number | null;
  rise_in: number | null;
  inseam_in: number | null;
  leg_opening_in: number | null;
  hip_in: number | null;
  condition: ClothingCondition;
}

export interface Photo {
  id: string;
  path: string;
  sort_order: number;
}

// No ItemPlatform type: the API surfaces platforms as a flat string[]
// (see ItemRelations below), never as full { id, item_id, platform,
// listed_at } rows — a per-row type here would describe a shape nothing
// in this app actually returns.

// Not exported, same reasoning as Status above: used to build
// ItemWithRelations below, never referenced by name elsewhere.
interface PriceHistoryEntry {
  id: string;
  item_id: string;
  previous_price: number | null;
  new_price: number | null;
  changed_at: string;
}

interface ItemBase {
  id: string;
  title: string;
  status: Status;
  acquisition_cost: number;
  acquisition_date: string;
  listing_price: number | null;
  sale_price: number | null;
  sale_platform: string | null;
  sale_date: string | null;
  created_at: string;
  updated_at: string;
}

export type Item =
  | (ItemBase & { category: 'book'; details: BookDetails })
  | (ItemBase & { category: 'clothing'; details: ClothingDetails });

interface ItemRelations {
  platforms: string[];
  price_history: PriceHistoryEntry[];
  photos: Photo[];
}

export type ItemWithRelations = Item & ItemRelations;
