'use client';

import { CredentialFields } from './CredentialFields';

interface AuthFormShellProps {
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordAutoComplete: 'current-password' | 'new-password';
  submitError: string;
  submitLoading: boolean;
  submitLabel: string;
  submitLoadingLabel: string;
  onSubmit: () => void;
}

/** Shared <form> shell for the login and signup pages — fields, inline error, submit button. */
export function AuthFormShell({
  email,
  onEmailChange,
  password,
  onPasswordChange,
  passwordAutoComplete,
  submitError,
  submitLoading,
  submitLabel,
  submitLoadingLabel,
  onSubmit,
}: AuthFormShellProps) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <CredentialFields
        email={email}
        onEmailChange={onEmailChange}
        password={password}
        onPasswordChange={onPasswordChange}
        passwordAutoComplete={passwordAutoComplete}
      />
      {submitError && <p role="alert">{submitError}</p>}
      <button type="submit" disabled={submitLoading}>
        {submitLoading ? submitLoadingLabel : submitLabel}
      </button>
    </form>
  );
}
