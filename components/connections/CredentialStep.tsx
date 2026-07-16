'use client';

import { useState } from 'react';
import type { SupportedPlatform } from '@/lib/constants';
import { credentialFieldSpecs } from '@/lib/constants/credentialFieldSpecs';
import { maskIdentifier } from '@/components/connections/maskIdentifier';

// ---------------------------------------------------------------------------
// CredentialStep — collects the identifier + secret fields for `platform`
// (per credentialFieldSpecs) and drives the two-call submit sequence:
//
//   1. POST /api/connections            { platform, credential }
//   2. POST /api/connections/:id/consent { disclosure_version }
//
// The `:id` used in step 2 MUST come from step 1's response body (`created.id`)
// — never from any connection id known before this component ran. This
// matters because the create endpoint handles a revoked-reconnect by
// deleting the old row and creating a brand new one with a NEW id; there is
// no prior "known" connectionId that is safe to reuse here, even if one
// exists from an earlier flow state.
//
// Standalone, prop-driven — not wired into ConnectionsView yet (later task).
// ---------------------------------------------------------------------------

interface ConnectionMetadata {
  id: string;
  platform: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CredentialStepProps {
  platform: SupportedPlatform;
  /** Disclosure version captured by ConsentScreen's onAffirm; consumed as-is,
   * never re-fetched here. */
  disclosureVersion: number;
  onSuccess: (params: {
    platform: SupportedPlatform;
    connectionId: string;
    maskedIdentifier: string;
  }) => void;
}

const GENERIC_ERROR = 'Something went wrong. Please try again.';

const CREATE_ERROR_MESSAGES: Record<string, string> = {
  invalid_credential: 'Those credentials could not be validated. Please check them and try again.',
  invalid_platform: 'This platform is not supported.',
  connection_exists: 'You already have an active connection for this platform.',
};

export default function CredentialStep({ platform, disclosureVersion, onSuccess }: CredentialStepProps) {
  const spec = credentialFieldSpecs[platform];

  const [credential, setCredential] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set right after the create POST succeeds (step 1), BEFORE the consent
  // POST is attempted, so it survives even if consent fails. The stale/
  // invalid-version retry re-POSTs consent against THIS id — the connection
  // is never recreated.
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  // Non-null when the consent POST came back 422 stale/invalid_disclosure_version:
  // holds the freshly-fetched current version to retry with, and doubles as
  // the "show retry banner" flag.
  const [retryVersion, setRetryVersion] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);

  function handleFieldChange(key: string, value: string) {
    setCredential((prev) => ({ ...prev, [key]: value }));
  }

  async function fetchCurrentDisclosureVersion(): Promise<number | null> {
    try {
      const res = await fetch('/api/disclosures/current');
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body?.version === 'number' ? body.version : null;
    } catch {
      return null;
    }
  }

  async function parseErrorCode(res: Response): Promise<string | undefined> {
    try {
      const body = await res.json();
      return typeof body?.error === 'string' ? body.error : undefined;
    } catch {
      return undefined;
    }
  }

  // Shared by handleSubmit's and handleRetryConsent's consent-POST failure
  // branches: parses the error code, and on a stale/invalid disclosure
  // version re-fetches the current one and shows the retry banner; any other
  // failure clears the retry banner and shows the generic error.
  async function handleConsentFailure(consentRes: Response): Promise<void> {
    const code = await parseErrorCode(consentRes);

    if (code === 'stale_disclosure_version' || code === 'invalid_disclosure_version') {
      const newVersion = await fetchCurrentDisclosureVersion();
      if (newVersion !== null) {
        setRetryVersion(newVersion);
        setError('The consent terms have been updated. Please review and retry.');
        return;
      }
    }
    setRetryVersion(null);
    setError(GENERIC_ERROR);
  }

  async function handleRetryConsent() {
    if (!pendingConnectionId || retryVersion === null || retrying) return;

    setRetrying(true);
    setError(null);

    try {
      const consentRes = await fetch(`/api/connections/${pendingConnectionId}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disclosure_version: retryVersion }),
      });

      if (!consentRes.ok) {
        await handleConsentFailure(consentRes);
        setRetrying(false);
        return;
      }

      const maskedIdentifier = maskIdentifier(credential[spec.identifierKey] ?? '');

      onSuccess({
        platform,
        connectionId: pendingConnectionId,
        maskedIdentifier,
      });
    } catch {
      // Network or unexpected error — no credential data in the message.
      setError(GENERIC_ERROR);
    } finally {
      setRetrying(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      // Step 1: create the connection. Never log `credential` (contains secrets).
      const createRes = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, credential }),
      });

      if (!createRes.ok) {
        const code = await parseErrorCode(createRes);
        setError((code && CREATE_ERROR_MESSAGES[code]) ?? GENERIC_ERROR);
        setSubmitting(false);
        return;
      }

      const created: ConnectionMetadata = await createRes.json();

      // Persist the connection id now, BEFORE attempting consent, so a
      // stale/invalid disclosure-version retry can re-submit consent against
      // this same connection without ever re-POSTing /api/connections.
      setPendingConnectionId(created.id);

      // Step 2: record consent against the id from THIS response — never a
      // previously-known id (see file header re: revoked-reconnect).
      const consentRes = await fetch(`/api/connections/${created.id}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disclosure_version: disclosureVersion }),
      });

      if (!consentRes.ok) {
        // The disclosure version we sent may be gone or outdated —
        // handleConsentFailure re-fetches the current version and surfaces a
        // retry banner in that case; the retry re-POSTs ONLY the consent call
        // (see handleRetryConsent), never recreating the connection.
        await handleConsentFailure(consentRes);
        setSubmitting(false);
        return;
      }

      const maskedIdentifier = maskIdentifier(credential[spec.identifierKey] ?? '');

      onSuccess({
        platform,
        connectionId: created.id,
        maskedIdentifier,
      });
    } catch {
      // Network or unexpected error — no credential data in the message.
      setError(GENERIC_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-lg mx-auto">
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="mb-4">
          <label
            htmlFor={spec.identifierKey}
            className="block text-sm text-gray-900 dark:text-gray-100 mb-1"
          >
            {spec.identifierLabel}
          </label>
          <input
            id={spec.identifierKey}
            type="text"
            autoComplete="off"
            value={credential[spec.identifierKey] ?? ''}
            onChange={(e) => handleFieldChange(spec.identifierKey, e.target.value)}
            className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
        </div>

        {spec.secretFields.map((field) => (
          <div className="mb-4" key={field.key}>
            <label
              htmlFor={field.key}
              className="block text-sm text-gray-900 dark:text-gray-100 mb-1"
            >
              {field.label}
            </label>
            <input
              id={field.key}
              type="password"
              autoComplete="off"
              value={credential[field.key] ?? ''}
              onChange={(e) => handleFieldChange(field.key, e.target.value)}
              className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
        ))}

        {retryVersion !== null ? (
          <div className="mb-4 rounded border border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-3">
            {error && (
              <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">{error}</p>
            )}
            <button
              type="button"
              onClick={() => void handleRetryConsent()}
              disabled={retrying}
              className="text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : (
          error && (
            <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
          )
        )}

        <button
          type="submit"
          disabled={submitting || retryVersion !== null}
          className="text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
