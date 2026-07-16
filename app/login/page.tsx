'use client';

import { useState } from 'react';
import { AuthFormShell } from '@/components/AuthFormShell';
import { useAuthForm } from '@/components/useAuthForm';
import { loginErrorMessage } from '@/lib/authErrorMessages';

// ---------------------------------------------------------------------------
// Minimal functional login page — FR29. Plain, unstyled-beyond-repo-baseline
// form; visual design is explicitly out of scope for this increment (see
// docs/reseller-multi-tenant-foundation/requirements.md, "Out of scope").
//
// POSTs to /api/auth/login (app/api/auth/login/route.ts): on success the
// server sets the session cookie via Set-Cookie and returns 200
// {tenant_id}; on bad credentials it returns a generic 401
// {error: 'Invalid email or password.'} (see that route's comments on why
// it never distinguishes "no such email" from "wrong password"). The
// browser attaches the Set-Cookie automatically on a same-origin fetch, so
// no explicit `credentials` option is needed.
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const { submitLoading, submitError, submit } = useAuthForm({
    endpoint: '/api/auth/login',
    successStatus: 200,
    errorMessage: loginErrorMessage,
  });

  return (
    <div>
      <h1>Log in</h1>
      <AuthFormShell
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        passwordAutoComplete="current-password"
        submitError={submitError}
        submitLoading={submitLoading}
        submitLabel="Log in"
        submitLoadingLabel="Logging in…"
        onSubmit={() => { void submit(email, password); }}
      />
      <p>
        No account? <a href="/signup">Sign up</a>
      </p>
    </div>
  );
}
