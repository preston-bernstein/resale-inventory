'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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

// Small component that reads search params and renders SSO error banner if
// sso_error=unmatched. Wrapped in Suspense to avoid Next.js App Router
// issues with useSearchParams() on the top-level page.
function SsoErrorBanner() {
  const searchParams = useSearchParams();
  const ssoError = searchParams.get('sso_error');

  if (ssoError === 'unmatched') {
    return (
      <p>
        Your SSO login isn&apos;t linked to a reseller account yet. Log in with
        email/password below, or contact the operator.
      </p>
    );
  }

  return null;
}

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
      <Suspense fallback={null}>
        <SsoErrorBanner />
      </Suspense>
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
