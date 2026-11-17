'use client';

import { useEffect, useState } from 'react';
import type { ConnectionMetadata } from '@/lib/connections';
import type { SupportedPlatform } from '@/lib/constants';
import { operabilityTiers } from '@/lib/constants/operabilityTiers';
import StatusRow from './StatusRow';

interface StatusListProps {
  connections: ConnectionMetadata[];
  /** Revoked row's reconnect action -- parent routes to that platform's consent screen for a fresh connection. */
  onReconnect: (platform: SupportedPlatform) => void;
  /** Active-but-unconsented row's "finish connecting" action -- parent routes to the consent screen for THIS existing connection, not a fresh one. */
  onResumeConsent: (connectionId: string, platform: SupportedPlatform) => void;
  /**
   * Optional: bubbled up from a row's successful reactivate, in addition to
   * this list's own per-connection consent refetch below. StatusList itself
   * doesn't own the `connections` array (that's a prop from further up, per
   * ConnectionsView.tsx), so it can't refetch the list itself -- a parent
   * that does own it (a later task wires ConnectionsView's fetchConnections
   * in here) can pass this to be told. Not required for StatusList to
   * function correctly on its own.
   */
  onStatusChange?: () => void;
}

// The app-layer allowlist (lib/constants.ts#SUPPORTED_PLATFORMS) is enforced
// at connection-creation time (app/api/connections/route.ts), so any
// connection.platform value reaching this component is guaranteed to be a
// real key of operabilityTiers -- indexing through a loosely-typed view
// rather than casting connection.platform (a plain string) as
// SupportedPlatform everywhere it's used.
function getOperabilityTier(platform: string): string {
  return (operabilityTiers as Record<string, string>)[platform] ?? 'unknown';
}

type ConsentByConnection = Record<string, boolean | null>;

async function fetchHasValidConsent(connectionId: string) {
  try {
    const res = await fetch(`/api/connections/${connectionId}/consent`);
    if (!res.ok) return [connectionId, null] as const;
    const json: { has_valid_consent: boolean } = await res.json();
    return [connectionId, json.has_valid_consent] as const;
  } catch {
    return [connectionId, null] as const;
  }
}

// null = this connection's consent fetch hasn't resolved yet.
function useConsentByConnection(connections: ConnectionMetadata[]): ConsentByConnection {
  const [consentByConnection, setConsentByConnection] = useState<ConsentByConnection>({});

  useEffect(() => {
    let cancelled = false;

    // Reset to "loading" for the current connection set up front -- avoids
    // briefly showing a stale/removed connection's old consent value under
    // a different connection's row if the id set changes.
    setConsentByConnection(Object.fromEntries(connections.map((c) => [c.id, null])));

    void Promise.all(connections.map((c) => fetchHasValidConsent(c.id))).then((results) => {
      if (cancelled) return;
      setConsentByConnection(Object.fromEntries(results));
    });

    return () => {
      cancelled = true;
    };
  }, [connections]);

  return consentByConnection;
}

export default function StatusList({
  connections,
  onReconnect,
  onResumeConsent,
  onStatusChange,
}: StatusListProps) {
  const consentByConnection = useConsentByConnection(connections);

  function handleRowStatusChange() {
    onStatusChange?.();
  }

  if (connections.length === 0) return null;

  return (
    <div data-testid="status-list" className="flex flex-col gap-2">
      {connections.map((connection) => {
        const platform = connection.platform as SupportedPlatform;
        return (
          <StatusRow
            key={connection.id}
            connection={connection}
            hasValidConsent={consentByConnection[connection.id] ?? null}
            operabilityTier={getOperabilityTier(connection.platform)}
            onReconnect={() => onReconnect(platform)}
            onResumeConsent={() => onResumeConsent(connection.id, platform)}
            onStatusChange={handleRowStatusChange}
          />
        );
      })}
    </div>
  );
}
