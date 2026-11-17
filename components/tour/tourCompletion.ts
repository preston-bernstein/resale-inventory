import type { Category } from '@/lib/constants';

const TOUR_STORAGE_PREFIX = 'presale-tour:v1:';

/**
 * Reads the per-category completion flag written by `markTourCompleted`.
 * Defensive against localStorage being unavailable (disabled, private mode,
 * quota exceeded) and against a corrupted/unparseable stored value — both
 * cases are treated as "not completed" rather than throwing. Only call this
 * from an effect (or other client-only code path), never at module scope or
 * synchronously during render, since Next.js can still prerender
 * 'use client' components on the server.
 */
export function isTourCompleted(category: Category): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return false;
    }

    const raw = window.localStorage.getItem(TOUR_STORAGE_PREFIX + category);

    if (!raw) {
      return false;
    }

    const parsed = JSON.parse(raw) as unknown;

    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'completed' in parsed &&
      (parsed as { completed: unknown }).completed === true
    );
  } catch {
    return false;
  }
}

/**
 * Writes the per-category completion flag. Swallows any localStorage error
 * (disabled, quota exceeded, private mode) so the tour always closes cleanly
 * even when the write can't be persisted.
 */
export function markTourCompleted(category: Category): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    window.localStorage.setItem(TOUR_STORAGE_PREFIX + category, JSON.stringify({ completed: true }));
  } catch {
    // Ignore — localStorage unavailable or full. Tour still closes normally.
  }
}
