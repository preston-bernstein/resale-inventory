'use client';

interface EmptyStateProps {
  /** Called when the CTA is clicked -- parent flips its own `cardsExpanded` state to true. */
  onExpand: () => void;
}

export default function EmptyState({ onExpand }: EmptyStateProps) {
  return (
    <div className="text-center py-12" data-testid="connections-empty-state">
      <p className="text-3xl mb-2" aria-hidden="true">🔗</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        No marketplaces connected yet — connect your first marketplace to start syncing your inventory.
      </p>
      <button
        type="button"
        onClick={onExpand}
        className="inline-block text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200"
      >
        Connect a marketplace
      </button>
    </div>
  );
}
