'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupportedPlatform } from '@/lib/constants';
import { getRiskCopy } from '@/lib/constants/riskCopy';

interface ConsentScreenProps {
  platform: SupportedPlatform;
  /** Called when the user clicks Continue with the checkbox checked. Passes
   * the fetched disclosure version through so a later step (CredentialStep)
   * can submit it to POST /api/connections/:id/consent without re-fetching. */
  onAffirm: (disclosureVersion: number) => void;
}

interface DisclosureResponse {
  version: number;
  content: string;
}

function useDisclosure() {
  const [disclosure, setDisclosure] = useState<DisclosureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDisclosure = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/disclosures/current');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DisclosureResponse = await res.json();
      setDisclosure(json);
    } catch (err) {
      console.error('fetchDisclosure failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to load disclosure.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDisclosure();
  }, [fetchDisclosure]);

  return { disclosure, loading, error, fetchDisclosure };
}

function DisclosureLoading() {
  return (
    <div className="p-6 max-w-lg mx-auto">
      <p className="text-sm text-gray-500 dark:text-gray-400">Loading disclosure...</p>
    </div>
  );
}

function DisclosureError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6 max-w-lg mx-auto">
      <p className="text-sm text-red-600 dark:text-red-400 mb-3">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200"
      >
        Retry
      </button>
    </div>
  );
}

export default function ConsentScreen({ platform, onAffirm }: ConsentScreenProps) {
  const { disclosure, loading, error, fetchDisclosure } = useDisclosure();
  const [affirmed, setAffirmed] = useState(false);

  function handleContinue() {
    if (!disclosure || !affirmed) return;
    onAffirm(disclosure.version);
  }

  if (loading) return <DisclosureLoading />;

  if (error || !disclosure) {
    return (
      <DisclosureError
        message={error ?? 'Failed to load disclosure.'}
        onRetry={() => void fetchDisclosure()}
      />
    );
  }

  return (
    <div className="p-6 max-w-lg mx-auto">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">Disclosure v{disclosure.version}</p>

      <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{disclosure.content}</p>

      <p className="text-sm text-gray-700 dark:text-gray-300 mt-4">{getRiskCopy(platform)}</p>

      <label className="flex items-start gap-2 mt-4 text-sm text-gray-900 dark:text-gray-100">
        <input
          type="checkbox"
          checked={affirmed}
          onChange={(e) => setAffirmed(e.target.checked)}
          className="mt-0.5"
        />
        I understand and accept these risks
      </label>

      <button
        type="button"
        onClick={handleContinue}
        disabled={!affirmed}
        className="mt-4 text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        I understand, continue
      </button>
    </div>
  );
}
