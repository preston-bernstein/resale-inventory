'use client';

import { useState } from 'react';
import { AuthFormShell } from '@/components/AuthFormShell';
import { useAuthForm } from '@/components/useAuthForm';
import { signupErrorMessage } from '@/lib/authErrorMessages';

// ---------------------------------------------------------------------------
// Minimal functional signup page — FR29. Plain, unstyled-beyond-repo-baseline
// form; visual design is explicitly out of scope for this increment (see
// docs/reseller-multi-tenant-foundation/requirements.md, "Out of scope").
//
// POSTs to /api/auth/signup (app/api/auth/signup/route.ts): on success the
// server sets the session cookie via Set-Cookie and returns 201
// {tenant_id}; on a taken email returns 409
// {error: 'Email already registered.'}; on a weak/missing password or
// email returns 422 {error: 'Validation failed.', fields: [...]}. The
// browser attaches the Set-Cookie automatically on a same-origin fetch, so
// no explicit `credentials` option is needed.
// ---------------------------------------------------------------------------

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const { submitLoading, submitError, submit } = useAuthForm({
    endpoint: '/api/auth/signup',
    successStatus: 201,
    errorMessage: signupErrorMessage,
  });

  return (
    <div>
      <h1>Sign up</h1>
      <AuthFormShell
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        passwordAutoComplete="new-password"
        submitError={submitError}
        submitLoading={submitLoading}
        submitLabel="Sign up"
        submitLoadingLabel="Signing up…"
        onSubmit={() => { void submit(email, password); }}
      />
      <p>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </div>
  );
}
