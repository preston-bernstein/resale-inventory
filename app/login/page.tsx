'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');
    setSubmitLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.status === 200) {
        router.push('/inventory');
        return;
      }

      const data = await res.json().catch(() => ({}));
      setSubmitError(data.error ?? 'Login failed.');
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  return (
    <div>
      <h1>Log in</h1>
      <form onSubmit={(e) => { void handleSubmit(e); }}>
        <div>
          <label htmlFor="email">Email</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {submitError && <p role="alert">{submitError}</p>}
        <button type="submit" disabled={submitLoading}>
          {submitLoading ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p>
        No account? <a href="/signup">Sign up</a>
      </p>
    </div>
  );
}
