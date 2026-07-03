export type BookStatus =
  | 'Unlisted'
  | 'Listed'
  | 'Sale Pending'
  | 'Sold'
  | 'Removed'
  | 'Donated'
  | 'Discarded';

export const ALLOWED_TRANSITIONS: Readonly<Record<BookStatus, ReadonlySet<BookStatus>>> = {
  Unlisted: new Set<BookStatus>(['Listed', 'Donated', 'Discarded']),
  Listed: new Set<BookStatus>(['Unlisted', 'Sale Pending', 'Removed', 'Donated', 'Discarded']),
  'Sale Pending': new Set<BookStatus>(['Listed', 'Sold']),
  Sold: new Set<BookStatus>(),
  Removed: new Set<BookStatus>(),
  Donated: new Set<BookStatus>(),
  Discarded: new Set<BookStatus>(),
};

export function assertTransitionAllowed(from: BookStatus, to: BookStatus): void {
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    throw new Error(`Transition ${from} → ${to} is not permitted.`);
  }
}
