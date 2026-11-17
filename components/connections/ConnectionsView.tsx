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

interface ConnectionsListProps {
  connections: ConnectionMetadata[];
  loading: boolean;
  cardsExpanded: boolean;
  setFlow: (flow: Flow) => void;
  onStatusChange: () => void;
}

// onResumeConsent (known limitation, out of scope for this wiring task):
// an active-but-unconsented connection resuming consent is
// routed the same as a fresh reconnect here. ConsentScreen ->
// CredentialStep always creates via POST /api/connections,
// which will 409 connection_exists for a connection whose
// status is already 'active' (vs 'revoked'). Carrying the
// existing connectionId through to a "resume consent without
// recreating" path is a future increment.
function ConnectionsList({
  connections,
  loading,
  cardsExpanded,
  setFlow,
  onStatusChange,
}: ConnectionsListProps) {
  return (
    <div data-testid="flow-list">
      {loading && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading connections...</p>
      )}
      {connections.length === 0 && !cardsExpanded ? (
        <EmptyState onExpand={() => setFlow({ mode: 'list', cardsExpanded: true })} />
      ) : (
        <div className="space-y-8">
          <ConnectCardGrid
            connections={connections}
            onSelectPlatform={(platform) => setFlow({ mode: 'consent', platform })}
          />
          <StatusList
            connections={connections}
            onReconnect={(platform) => setFlow({ mode: 'consent', platform })}
            onResumeConsent={(_connectionId, platform) =>
              setFlow({ mode: 'consent', platform })
            }
            onStatusChange={onStatusChange}
          />
        </div>
      )}
    </div>
  );
}

type GuidedFlow = Exclude<Flow, { mode: 'list' }>;

interface GuidedStepProps {
  flow: GuidedFlow;
  disclosureVersion: number;
  onAffirm: (platform: SupportedPlatform, version: number) => void;
  onConnected: (confirmed: Extract<Flow, { mode: 'confirmed' }>) => void;
}

function GuidedStep({ flow, disclosureVersion, onAffirm, onConnected }: GuidedStepProps) {
  if (flow.mode === 'consent') {
    return (
      <ConsentScreen
        platform={flow.platform}
        onAffirm={(version) => onAffirm(flow.platform, version)}
      />
    );
  }

  if (flow.mode === 'credential') {
    return (
      <CredentialStep
        platform={flow.platform}
        disclosureVersion={disclosureVersion}
        onSuccess={({ platform, connectionId, maskedIdentifier }) =>
          onConnected({ mode: 'confirmed', platform, connectionId, maskedIdentifier })
        }
      />
    );
  }

  return (
    <ConnectionConfirmation platform={flow.platform} maskedIdentifier={flow.maskedIdentifier}>
      <FirstWinPanel connectionId={flow.connectionId} />
    </ConnectionConfirmation>
  );
}

export default function ConnectionsView({ tenantId, etsyResult }: ConnectionsViewProps) {
  const [flow, setFlow] = useState<Flow>({ mode: 'list', cardsExpanded: false });
  const { connections, loading, error, fetchConnections } = useConnections();
  // Captured by ConsentScreen's onAffirm, consumed by CredentialStep's
  // disclosureVersion prop. Lives here (not on the Flow union) because it
  // needs to survive the consent -> credential transition without being part
  // of the discriminant.
  const [pendingDisclosureVersion, setPendingDisclosureVersion] = useState<number | null>(null);

  return (
    <div data-testid="connections-view" data-tenant-id={tenantId}>
      <EtsyResultBanner result={etsyResult} />
      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>}

      {flow.mode === 'list' ? (
        <ConnectionsList
          connections={connections}
          loading={loading}
          cardsExpanded={flow.cardsExpanded}
          setFlow={setFlow}
          onStatusChange={() => void fetchConnections()}
        />
      ) : (
        <GuidedStep
          flow={flow}
          disclosureVersion={pendingDisclosureVersion ?? 0}
          onAffirm={(platform, version) => {
            setPendingDisclosureVersion(version);
            setFlow({ mode: 'credential', platform });
          }}
          onConnected={(confirmed) => {
            setFlow(confirmed);
            // Refetch so the newly-created connection is already present in
            // `connections` by the time the user navigates back to 'list'.
            void fetchConnections();
          }}
        />
      )}
    </div>
  );
}
