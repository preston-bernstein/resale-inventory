'use client';

import { useState } from 'react';
import type { ConnectionMetadata } from '@/lib/connections';
import EtsyLinkButton from './EtsyLinkButton';

interface StatusRowProps {
  connection: ConnectionMetadata;
  /** null while StatusList's own per-connection consent fetch (GET /api/connections/:id/consent) is still in flight. */
  hasValidConsent: boolean | null;
  /** Static per-platform display string from lib/constants/operabilityTiers.ts, e.g. 'sandbox-tested'. Informational only -- never represents connection.status. */
  operabilityTier: string;
  /** Revoked row's "Reconnect" action -- parent routes to that platform's consent screen (a fresh connection). */
  onReconnect: () => void;
  /** Active-but-unconsented row's "finish connecting" action -- parent routes to the consent screen for THIS existing connection, not a fresh one. */
  onResumeConsent: () => void;
  /** Told to the parent after a successful reactivate, so it can refetch the connections list. */
  onStatusChange: () => void;
}

// Color convention (plan.md): green/yellow/red map 1:1 to the status enum
// itself; blue is reserved for informational facts only (operability tier,
// and the stale-consent indicator below) and must never stand in for a
// status. Same className shape as ItemCardGrid.tsx's STATUS_STYLES.
const STATUS_BADGE_STYLES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  suspended: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  revoked: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300',
};

const FALLBACK_BADGE_STYLE = 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
const INFO_BADGE_STYLE = 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300';

// Resolves to the message to show, or null when the reactivate succeeded.
async function requestReactivate(connectionId: string): Promise<string | null> {
  const res = await fetch(`/api/connections/${connectionId}/reactivate`, {
    method: 'POST',
  });

  if (res.status === 409) {
    return 'This connection is no longer suspended -- it may already be active, or revoked (revoked connections must be reconnected instead).';
  }
  if (!res.ok) {
    return `Reactivation failed (HTTP ${res.status}).`;
  }
  return null;
}

interface ReactivateControlProps {
  connectionId: string;
  onStatusChange: () => void;
}

// Self-contained row action (not delegated to the parent): this control owns
// its fetch since reactivating one row has no bearing on any other row's
// render. Success bubbles up via onStatusChange so whichever ancestor owns
// the connections list can refetch it; a 409 (already active, or revoked --
// no reactivate path exists for revoked) is surfaced inline, never silently
// swallowed.
function ReactivateControl({ connectionId, onStatusChange }: ReactivateControlProps) {
  const [reactivating, setReactivating] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  async function handleReactivate() {
    setReactivating(true);
    setReactivateError(null);
    try {
      const message = await requestReactivate(connectionId);
      if (message === null) onStatusChange();
      else setReactivateError(message);
    } catch (err) {
      console.error('handleReactivate failed:', err);
      setReactivateError('Reactivation failed -- check your connection and try again.');
    } finally {
      setReactivating(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void handleReactivate()}
        disabled={reactivating}
        className="text-xs px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {reactivating ? 'Reactivating…' : 'Reactivate'}
      </button>
      {reactivateError && (
        <span
          data-testid={`reactivate-error-${connectionId}`}
          role="alert"
          className="text-xs text-rose-600 dark:text-rose-400"
        >
          {reactivateError}
        </span>
      )}
    </div>
  );
}

function StatusBadges({ connection, operabilityTier }: { connection: ConnectionMetadata; operabilityTier: string }) {
  const badgeStyle = STATUS_BADGE_STYLES[connection.status] ?? FALLBACK_BADGE_STYLE;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">
        {connection.platform}
      </span>
      <div className="flex items-center gap-2">
        <span
          data-testid={`status-badge-${connection.id}`}
          className={`text-xs px-2 py-0.5 rounded ${badgeStyle}`}
        >
          {connection.status}
        </span>
        <span
          data-testid={`operability-tier-${connection.id}`}
          className={`text-xs px-2 py-0.5 rounded ${INFO_BADGE_STYLE}`}
        >
          {operabilityTier}
        </span>
      </div>
    </div>
  );
}

function StaleConsentNotice({ connectionId, onResumeConsent }: { connectionId: string; onResumeConsent: () => void }) {
  return (
    <div
      data-testid={`stale-consent-${connectionId}`}
      className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-300"
    >
      <span>Consent needed to resume automation.</span>
      <button
        type="button"
        onClick={onResumeConsent}
        className="shrink-0 px-2 py-0.5 rounded bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-700 dark:hover:bg-sky-600"
      >
        Finish connecting
      </button>
    </div>
  );
}

export default function StatusRow({
  connection,
  hasValidConsent,
  operabilityTier,
  onReconnect,
  onResumeConsent,
  onStatusChange,
}: StatusRowProps) {
  const showStaleConsent = connection.status === 'active' && hasValidConsent === false;

  return (
    <div
      data-testid={`status-row-${connection.id}`}
      className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 flex flex-col gap-2"
    >
      <StatusBadges connection={connection} operabilityTier={operabilityTier} />

      {showStaleConsent && (
        <StaleConsentNotice connectionId={connection.id} onResumeConsent={onResumeConsent} />
      )}

      {connection.platform === 'etsy' && connection.status === 'active' && (
        <EtsyLinkButton connectionId={connection.id} />
      )}

      {connection.status === 'suspended' && (
        <ReactivateControl connectionId={connection.id} onStatusChange={onStatusChange} />
      )}

      {connection.status === 'revoked' && (
        <div>
          <button
            type="button"
            onClick={onReconnect}
            className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
