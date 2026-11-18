import { useState } from 'react';
import type { SupportedPlatform } from '@/lib/constants';
import { credentialFieldSpecs } from '@/lib/constants/credentialFieldSpecs';
import { maskIdentifier } from '@/components/connections/maskIdentifier';

interface ConnectionMetadata {
  id: string;
  platform: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialSubmitOptions {
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

interface ConsentFailure {
  /** Fresh disclosure version to retry with, or null when a retry cannot help. */
  retryVersion: number | null;
  error: string;
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

// Shared by the submit and retry consent-POST failure branches: parses the
// error code, and on a stale/invalid disclosure version re-fetches the
// current one so the retry banner can show; any other failure clears the
// retry banner and shows the generic error.
async function describeConsentFailure(consentRes: Response): Promise<ConsentFailure> {
  const code = await parseErrorCode(consentRes);

  if (code === 'stale_disclosure_version' || code === 'invalid_disclosure_version') {
    const newVersion = await fetchCurrentDisclosureVersion();
    if (newVersion !== null) {
      return {
        retryVersion: newVersion,
        error: 'The consent terms have been updated. Please review and retry.',
      };
    }
  }
  return { retryVersion: null, error: GENERIC_ERROR };
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postConsent(connectionId: string, disclosureVersion: number): Promise<Response> {
  return postJson(`/api/connections/${connectionId}/consent`, {
    disclosure_version: disclosureVersion,
  });
}

type SubmitOutcome =
  | { kind: 'done'; connectionId: string }
  | { kind: 'error'; message: string }
  | { kind: 'consent_failed'; failure: ConsentFailure };

async function consentOutcome(connectionId: string, disclosureVersion: number): Promise<SubmitOutcome> {
  const consentRes = await postConsent(connectionId, disclosureVersion);
  if (consentRes.ok) return { kind: 'done', connectionId };
  // The disclosure version we sent may be gone or outdated —
  // describeConsentFailure re-fetches the current version so the caller can
  // surface a retry banner; the retry re-POSTs ONLY the consent call, never
  // recreating the connection.
  return { kind: 'consent_failed', failure: await describeConsentFailure(consentRes) };
}

// Step 1 creates the connection, step 2 records consent against the id from
// THAT response — never a previously-known id (see CredentialStep.tsx header
// re: revoked-reconnect). `onCreated` fires BEFORE the consent call, so the
// id survives a consent failure and a retry can reuse it.
async function createAndConsent(
  platform: SupportedPlatform,
  credential: Record<string, string>,
  disclosureVersion: number,
  onCreated: (connectionId: string) => void,
): Promise<SubmitOutcome> {
  // Never log `credential` (contains secrets).
  const createRes = await postJson('/api/connections', { platform, credential });

  if (!createRes.ok) {
    const code = await parseErrorCode(createRes);
    return { kind: 'error', message: (code && CREATE_ERROR_MESSAGES[code]) ?? GENERIC_ERROR };
  }

  const created: ConnectionMetadata = await createRes.json();
  onCreated(created.id);
  return consentOutcome(created.id, disclosureVersion);
}

interface SubmitState {
  submitting: boolean;
  retrying: boolean;
  error: string | null;
  /** Set right after the create POST succeeds, BEFORE the consent POST is
   * attempted, so it survives a consent failure. The retry re-POSTs consent
   * against THIS id; the connection is never recreated. */
  pendingConnectionId: string | null;
  /** Non-null when the consent POST came back 422 stale/invalid_disclosure_version:
   * the freshly-fetched current version to retry with. Doubles as the "show
   * retry banner" flag. */
  retryVersion: number | null;
}

const INITIAL_SUBMIT_STATE: SubmitState = {
  submitting: false,
  retrying: false,
  error: null,
  pendingConnectionId: null,
  retryVersion: null,
};

// Runs one network step. A thrown error becomes the generic message. Never
// log `credential` itself, only the caught error (a fetch/parse failure,
// never the request body).
async function runStep(label: string, step: () => Promise<SubmitOutcome>): Promise<SubmitOutcome> {
  try {
    return await step();
  } catch (err) {
    console.error(`${label} failed:`, err);
    return { kind: 'error', message: GENERIC_ERROR };
  }
}

export function useCredentialSubmit({
  platform,
  disclosureVersion,
  onSuccess,
}: CredentialSubmitOptions) {
  const spec = credentialFieldSpecs[platform];
  const [credential, setCredential] = useState<Record<string, string>>({});
  const [state, setState] = useState(INITIAL_SUBMIT_STATE);
  const patch = (changes: Partial<SubmitState>) => setState((prev) => ({ ...prev, ...changes }));

  function setField(key: string, value: string) {
    setCredential((prev) => ({ ...prev, [key]: value }));
  }

  function applyOutcome(outcome: SubmitOutcome) {
    if (outcome.kind === 'done') {
      const maskedIdentifier = maskIdentifier(credential[spec.identifierKey] ?? '');
      onSuccess({ platform, connectionId: outcome.connectionId, maskedIdentifier });
    } else if (outcome.kind === 'error') {
      patch({ error: outcome.message });
    } else {
      patch({ retryVersion: outcome.failure.retryVersion, error: outcome.failure.error });
    }
  }

  async function handleRetryConsent() {
    const { pendingConnectionId, retryVersion, retrying } = state;
    if (!pendingConnectionId || retryVersion === null || retrying) return;

    patch({ retrying: true, error: null });
    applyOutcome(await runStep('handleRetryConsent', () => consentOutcome(pendingConnectionId, retryVersion)));
    patch({ retrying: false });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state.submitting) return;

    patch({ submitting: true, error: null });
    const createStep = () =>
      createAndConsent(platform, credential, disclosureVersion, (id) =>
        patch({ pendingConnectionId: id }),
      );
    applyOutcome(await runStep('handleSubmit', createStep));
    patch({ submitting: false });
  }

  return { spec, credential, setField, ...state, handleSubmit, handleRetryConsent };
}
