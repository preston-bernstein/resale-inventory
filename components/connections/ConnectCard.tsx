'use client';

import type { SupportedPlatform } from '@/lib/constants';
import type { ConnectionMetadata } from '@/lib/connections';
import type { PlatformTier } from '@/lib/constants/platformTiers';

interface ConnectCardProps {
  platform: SupportedPlatform;
  tier: PlatformTier;
  /** The existing connection for this platform, if any -- found by the parent grid via connections.find(c => c.platform === platform). */
  connection: ConnectionMetadata | undefined;
  /** Called when an enabled card (no connection, or a revoked one) is clicked. */
  onSelect: () => void;
}

const TIER_LABELS: Record<PlatformTier, string> = {
  oauth: 'OAuth',
  credential: 'Credential',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ConnectCard({ platform, tier, connection, onSelect }: ConnectCardProps) {
  const status = connection?.status;
  // Disabled (inert card) when there's an active or suspended connection --
  // those route to a status view (out of scope for this task), not a
  // reconnect flow. Enabled when there's no connection yet, or the existing
  // one was revoked (a fresh connect is the only way forward from revoked).
  const disabled = status === 'active' || status === 'suspended';

  return (
    <div
      data-testid={`connect-card-${platform}`}
      data-status={status ?? 'none'}
      className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 p-2.5"
    >
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-snug">{capitalize(platform)}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{TIER_LABELS[tier]}</p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1" data-testid={`connect-card-status-${platform}`}>
        {connection ? capitalize(status as string) : 'Not connected'}
      </p>

      <div className="mt-2">
        {disabled ? (
          // Disabled cards are inert -- no clickable element. A future task
          // routes a click here to a status view; that routing is out of
          // scope for this task, so the card simply doesn't render a button.
          <span className="inline-block text-xs px-3 py-1.5 text-gray-400 dark:text-gray-600" aria-hidden="true">
            {capitalize(status as string)}
          </span>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            className="text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
