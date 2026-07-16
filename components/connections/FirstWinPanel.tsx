'use client';

import { useEffect, useState } from 'react';

interface FirstWinPanelProps {
  connectionId: string;
}

interface FirstWinResponse {
  healthy: boolean;
  detail?: string;
  readyCount: number;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'success'; data: FirstWinResponse };

/** Skeleton shown while the first-win check is in flight. */
function FirstWinSkeleton() {
  return (
    <div
      data-testid="first-win-skeleton"
      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 animate-pulse motion-reduce:animate-none"
      aria-hidden="true"
    >
      <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/5" />
      <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/5 mt-2" />
    </div>
  );
}

export default function FirstWinPanel({ connectionId }: FirstWinPanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const res = await fetch(`/api/connections/${connectionId}/first-win`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: FirstWinResponse = await res.json();
        if (cancelled) return;
        setState({ status: 'success', data: json });
      } catch {
        if (cancelled) return;
        setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (state.status === 'loading') {
    return <FirstWinSkeleton />;
  }

  if (state.status === 'error') {
    return (
      <p
        data-testid="first-win-error"
        className="text-sm text-red-600 dark:text-red-400"
      >
        Couldn&apos;t check connection status.
      </p>
    );
  }

  const { healthy, detail, readyCount } = state.data;

  return (
    <div data-testid="first-win-panel" className="flex flex-col gap-2">
      {healthy ? (
        <p
          data-testid="first-win-health"
          className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"
        >
          <span aria-hidden="true">✓</span>
          Connected and healthy
        </p>
      ) : (
        <p
          data-testid="first-win-health"
          className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5"
        >
          <span aria-hidden="true">✕</span>
          {detail ?? 'Connection issue detected'}
        </p>
      )}

      {readyCount > 0 ? (
        <p
          data-testid="first-win-ready-count"
          className="text-sm text-gray-700 dark:text-gray-300"
        >
          {readyCount} {readyCount === 1 ? 'item' : 'items'} ready to list
        </p>
      ) : (
        <p
          data-testid="first-win-ready-count"
          className="text-sm text-gray-500 dark:text-gray-400"
        >
          No items in your inventory are ready to list yet.
        </p>
      )}
    </div>
  );
}
