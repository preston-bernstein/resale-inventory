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

const BUTTON_CLASS =
  'text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed';

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

interface ConsentFailureOutcome {
  /** The freshly-fetched current version to retry with; null when a retry cannot help. */
  retryVersion: number | null;
  message: string;
}

// Shared by the submit and retry flows' consent-POST failure branches: parses
// the error code, and on a stale/invalid disclosure version re-fetches the
// current one so the retry banner can show; any other failure clears the
// retry banner and shows the generic error.
async function classifyConsentFailure(consentRes: Response): Promise<ConsentFailureOutcome> {
  const code = await parseErrorCode(consentRes);

  if (code === 'stale_disclosure_version' || code === 'invalid_disclosure_version') {
    const newVersion = await fetchCurrentDisclosureVersion();
    if (newVersion !== null) {
      return {
        retryVersion: newVersion,
        message: 'The consent terms have been updated. Please review and retry.',
      };
    }
  }
  return { retryVersion: null, message: GENERIC_ERROR };
}

type FlowOutcome =
  | { kind: 'success'; connectionId: string }
  // retryVersion undefined means "leave the retry banner as it is".
  | { kind: 'failure'; message: string; retryVersion?: number | null };

async function postConsent(connectionId: string, version: number): Promise<FlowOutcome> {
  const consentRes = await postJson(`/api/connections/${connectionId}/consent`, {
    disclosure_version: version,
  });
  if (consentRes.ok) return { kind: 'success', connectionId };

  // The disclosure version we sent may be gone or outdated — the failure
  // carries a fresh version when so, and the retry re-POSTs ONLY the consent
  // call, never recreating the connection.
  return { kind: 'failure', ...(await classifyConsentFailure(consentRes)) };
}

interface SubmitRequest {
  platform: SupportedPlatform;
  credential: Record<string, string>;
  disclosureVersion: number;
}

async function createConnectionThenConsent(
  { platform, credential, disclosureVersion }: SubmitRequest,
  onCreated: (connectionId: string) => void,
): Promise<FlowOutcome> {
  // Step 1: create the connection. Never log `credential` (contains secrets).
  const createRes = await postJson('/api/connections', { platform, credential });

  if (!createRes.ok) {
    const code = await parseErrorCode(createRes);
    return { kind: 'failure', message: (code && CREATE_ERROR_MESSAGES[code]) ?? GENERIC_ERROR };
  }

  const created: ConnectionMetadata = await createRes.json();

  // Persist the connection id now, BEFORE attempting consent, so a
  // stale/invalid disclosure-version retry can re-submit consent against
  // this same connection without ever re-POSTing /api/connections.
  onCreated(created.id);

  // Step 2: record consent against the id from THIS response — never a
  // previously-known id (see file header re: revoked-reconnect).
  return postConsent(created.id, disclosureVersion);
}

interface CredentialInputProps {
  id: string;
  label: string;
  type: 'text' | 'password';
  value: string;
  onChange: (value: string) => void;
}

function CredentialInput({ id, label, type, value, onChange }: CredentialInputProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-sm text-gray-900 dark:text-gray-100 mb-1">
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
      />
    </div>
  );
}

interface RetryBannerProps {
  error: string | null;
  retrying: boolean;
  onRetry: () => void;
}

function RetryBanner({ error, retrying, onRetry }: RetryBannerProps) {
  return (
    <div className="mb-4 rounded border border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-3">
      {error && <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">{error}</p>}
      <button type="button" onClick={onRetry} disabled={retrying} className={BUTTON_CLASS}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

// Retry state for the consent POST, which can fail after the connection was
// already created.
function useConsentRetryState() {
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

  return { pendingConnectionId, setPendingConnectionId, retryVersion, setRetryVersion, retrying, setRetrying };
}

// Runs one submit or retry flow and reports its outcome through the step's
// callbacks. A thrown error is a network or unexpected failure — never log
// `credential` itself, only the caught error (a fetch/parse failure, never
// the request body).
function useFlowRunner(
  { platform, onSuccess }: CredentialStepProps,
  credential: Record<string, string>,
  setError: (message: string | null) => void,
  setRetryVersion: (version: number | null) => void,
) {
  const identifierKey = credentialFieldSpecs[platform].identifierKey;

  function applyOutcome(outcome: FlowOutcome) {
    if (outcome.kind === 'success') {
      onSuccess({
        platform,
        connectionId: outcome.connectionId,
        maskedIdentifier: maskIdentifier(credential[identifierKey] ?? ''),
      });
      return;
    }
    setError(outcome.message);
    if (outcome.retryVersion !== undefined) setRetryVersion(outcome.retryVersion);
  }

  return async function runFlow(label: string, setBusy: (busy: boolean) => void, flow: () => Promise<FlowOutcome>) {
    try {
      applyOutcome(await flow());
    } catch (err) {
      console.error(`${label} failed:`, err);
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  };
}

function useCredentialStep(props: CredentialStepProps) {
  const { platform, disclosureVersion } = props;
  const spec = credentialFieldSpecs[platform];

  const [credential, setCredential] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consent = useConsentRetryState();
  const { pendingConnectionId, retryVersion, retrying } = consent;
  const runFlow = useFlowRunner(props, credential, setError, consent.setRetryVersion);

  function handleFieldChange(key: string, value: string) {
    setCredential((prev) => ({ ...prev, [key]: value }));
  }

  async function handleRetryConsent() {
    if (!pendingConnectionId || retryVersion === null || retrying) return;

    consent.setRetrying(true);
    setError(null);
    await runFlow('handleRetryConsent', consent.setRetrying, () =>
      postConsent(pendingConnectionId, retryVersion),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    await runFlow('handleSubmit', setSubmitting, () =>
      createConnectionThenConsent({ platform, credential, disclosureVersion }, consent.setPendingConnectionId),
    );
  }

  return { spec, credential, submitting, error, retryVersion, retrying, handleFieldChange, handleRetryConsent, handleSubmit };
}

export default function CredentialStep(props: CredentialStepProps) {
  const step = useCredentialStep(props);
  const { spec, credential, error, retryVersion } = step;

  return (
    <div className="p-6 max-w-lg mx-auto">
      <form onSubmit={(e) => void step.handleSubmit(e)}>
        <CredentialInput
          id={spec.identifierKey}
          label={spec.identifierLabel}
          type="text"
          value={credential[spec.identifierKey] ?? ''}
          onChange={(value) => step.handleFieldChange(spec.identifierKey, value)}
        />

        {spec.secretFields.map((field) => (
          <CredentialInput
            key={field.key}
            id={field.key}
            label={field.label}
            type="password"
            value={credential[field.key] ?? ''}
            onChange={(value) => step.handleFieldChange(field.key, value)}
          />
        ))}

        {retryVersion !== null ? (
          <RetryBanner
            error={error}
            retrying={step.retrying}
            onRetry={() => void step.handleRetryConsent()}
          />
        ) : (
          error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
        )}

        <button
          type="submit"
          disabled={step.submitting || retryVersion !== null}
          className={BUTTON_CLASS}
        >
          {step.submitting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
