'use client';

import { useEffect, useState, useCallback } from 'react';
import type { ConnectionMetadata } from '@/lib/connections';
import type { SupportedPlatform } from '@/lib/constants';
import EmptyState from './EmptyState';
import ConnectCardGrid from './ConnectCardGrid';
import StatusList from './StatusList';
import ConsentScreen from './ConsentScreen';
import CredentialStep from './CredentialStep';
import ConnectionConfirmation from './ConnectionConfirmation';
import FirstWinPanel from './FirstWinPanel';
import EtsyResultBanner from './EtsyResultBanner';

// Discriminated-union flow state (plan.md). This is the single source of
// truth for which screen the user is on. `platform` is typed as
// SupportedPlatform throughout (not plain `string`) because every value ever
// assigned to it already comes from a SupportedPlatform-typed source
// (ConnectCardGrid's onSelectPlatform, StatusList's onReconnect/
// onResumeConsent), so no cast is needed at any transition site below.
type Flow =
  | { mode: 'list'; cardsExpanded: boolean }
  | { mode: 'consent'; platform: SupportedPlatform }
  | { mode: 'credential'; platform: SupportedPlatform }
  | {
      mode: 'confirmed';
      platform: SupportedPlatform;
      connectionId: string;
      maskedIdentifier: string;
    };

interface ConnectionsViewProps {
  tenantId: string;
  /** `?etsy=` result code from the Etsy OAuth callback redirect, if any. */
  etsyResult?: string;
}

interface ConnectionsListScreenProps {
  connections: ConnectionMetadata[];
  loading: boolean;
  cardsExpanded: boolean;
  onExpandCards: () => void;
  onChoosePlatform: (platform: SupportedPlatform) => void;
  onStatusChange: () => void;
}

interface CredentialSuccess {
  platform: SupportedPlatform;
  connectionId: string;
  maskedIdentifier: string;
}

function useConnections() {
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/connections');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ConnectionMetadata[] = await res.json();
      setConnections(json);
    } catch (err) {
      console.error('fetchConnections failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to load connections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  return { connections, loading, error, fetchConnections };
}

// NOTE (known limitation, out of scope for this wiring task): an
// active-but-unconsented connection resuming consent is routed the same as a
// fresh reconnect here. ConsentScreen -> CredentialStep always creates via
// POST /api/connections, which will 409 connection_exists for a connection
// whose status is already 'active' (vs 'revoked'). Carrying the existing
// connectionId through to a "resume consent without recreating" path is a
// future increment.
function ConnectionsListScreen({
  connections,
  loading,
  cardsExpanded,
  onExpandCards,
  onChoosePlatform,
  onStatusChange,
}: ConnectionsListScreenProps) {
  return (
    <div data-testid="flow-list">
      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading connections...</p>}
      {connections.length === 0 && !cardsExpanded ? (
        <EmptyState onExpand={onExpandCards} />
      ) : (
        <div className="space-y-8">
          <ConnectCardGrid connections={connections} onSelectPlatform={onChoosePlatform} />
          <StatusList
            connections={connections}
            onReconnect={onChoosePlatform}
            onResumeConsent={(_connectionId, platform) => onChoosePlatform(platform)}
            onStatusChange={onStatusChange}
          />
        </div>
      )}
    </div>
  );
}

function useConnectionsFlow(fetchConnections: () => Promise<void>) {
  const [flow, setFlow] = useState<Flow>({ mode: 'list', cardsExpanded: false });
  // Captured by ConsentScreen's onAffirm, consumed by CredentialStep's
  // disclosureVersion prop. Lives here (not on the Flow union) because it
  // needs to survive the consent -> credential transition without being part
  // of the discriminant.
  const [pendingDisclosureVersion, setPendingDisclosureVersion] = useState<number | null>(null);

  return {
    flow,
    disclosureVersion: pendingDisclosureVersion ?? 0,
    expandCards: () => setFlow({ mode: 'list', cardsExpanded: true }),
    choosePlatform: (platform: SupportedPlatform) => setFlow({ mode: 'consent', platform }),
    affirmDisclosure: (version: number) => {
      if (flow.mode !== 'consent') return;
      setPendingDisclosureVersion(version);
      setFlow({ mode: 'credential', platform: flow.platform });
    },
    completeCredential: (success: CredentialSuccess) => {
      setFlow({ mode: 'confirmed', ...success });
      // Refetch so the newly-created connection is already present in
      // `connections` by the time the user navigates back to 'list'.
      void fetchConnections();
    },
  };
}

export default function ConnectionsView({ tenantId, etsyResult }: ConnectionsViewProps) {
  const { connections, loading, error, fetchConnections } = useConnections();
  const step = useConnectionsFlow(fetchConnections);
  const { flow } = step;

  return (
    <div data-testid="connections-view" data-tenant-id={tenantId}>
      <EtsyResultBanner result={etsyResult} />
      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

      {flow.mode === 'list' && (
        <ConnectionsListScreen
          connections={connections}
          loading={loading}
          cardsExpanded={flow.cardsExpanded}
          onExpandCards={step.expandCards}
          onChoosePlatform={step.choosePlatform}
          onStatusChange={() => void fetchConnections()}
        />
      )}

      {flow.mode === 'consent' && (
        <ConsentScreen platform={flow.platform} onAffirm={step.affirmDisclosure} />
      )}

      {flow.mode === 'credential' && (
        <CredentialStep
          platform={flow.platform}
          disclosureVersion={step.disclosureVersion}
          onSuccess={step.completeCredential}
        />
      )}

      {flow.mode === 'confirmed' && (
        <ConnectionConfirmation platform={flow.platform} maskedIdentifier={flow.maskedIdentifier}>
          <FirstWinPanel connectionId={flow.connectionId} />
        </ConnectionConfirmation>
      )}
    </div>
  );
}
