'use client';

import type { CredentialSubmitOptions } from './useCredentialSubmit';
import { useCredentialSubmit } from './useCredentialSubmit';

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

type CredentialStepProps = CredentialSubmitOptions;

const INPUT_CLASS =
  'w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100';
const BUTTON_CLASS =
  'text-sm px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed';

interface CredentialFieldProps {
  id: string;
  label: string;
  type: 'text' | 'password';
  value: string;
  onChange: (value: string) => void;
}

function CredentialField({ id, label, type, value, onChange }: CredentialFieldProps) {
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
        className={INPUT_CLASS}
      />
    </div>
  );
}

interface CredentialFeedbackProps {
  error: string | null;
  retryVersion: number | null;
  retrying: boolean;
  onRetry: () => void;
}

function CredentialFeedback({ error, retryVersion, retrying, onRetry }: CredentialFeedbackProps) {
  if (retryVersion === null) {
    return error ? <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p> : null;
  }
  return (
    <div className="mb-4 rounded border border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-3">
      {error && <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">{error}</p>}
      <button type="button" onClick={onRetry} disabled={retrying} className={BUTTON_CLASS}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

function ConnectButton({ disabled, submitting }: { disabled: boolean; submitting: boolean }) {
  return (
    <button type="submit" disabled={disabled} className={BUTTON_CLASS}>
      {submitting ? 'Connecting…' : 'Connect'}
    </button>
  );
}

export default function CredentialStep(props: CredentialStepProps) {
  const {
    spec,
    credential,
    setField,
    submitting,
    error,
    retryVersion,
    retrying,
    handleSubmit,
    handleRetryConsent,
  } = useCredentialSubmit(props);

  return (
    <div className="p-6 max-w-lg mx-auto">
      <form onSubmit={(e) => void handleSubmit(e)}>
        <CredentialField
          id={spec.identifierKey}
          label={spec.identifierLabel}
          type="text"
          value={credential[spec.identifierKey] ?? ''}
          onChange={(value) => setField(spec.identifierKey, value)}
        />

        {spec.secretFields.map((field) => (
          <CredentialField
            key={field.key}
            id={field.key}
            label={field.label}
            type="password"
            value={credential[field.key] ?? ''}
            onChange={(value) => setField(field.key, value)}
          />
        ))}

        <CredentialFeedback
          error={error}
          retryVersion={retryVersion}
          retrying={retrying}
          onRetry={() => void handleRetryConsent()}
        />

        <ConnectButton disabled={submitting || retryVersion !== null} submitting={submitting} />
      </form>
    </div>
  );
}
