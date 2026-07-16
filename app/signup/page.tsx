'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.status === 201) {
        router.push('/inventory');
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setSubmitError(data.error ?? 'Email already registered.');
      } else if (res.status === 422) {
        const fields = Array.isArray(data.fields) ? data.fields.join(', ') : '';
        setSubmitError(fields ? `Validation failed: ${fields}.` : (data.error ?? 'Validation failed.'));
      } else {
        setSubmitError(data.error ?? 'Signup failed.');
      }
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  return (
    <div>
      <h1>Sign up</h1>
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
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {submitError && <p role="alert">{submitError}</p>}
        <button type="submit" disabled={submitLoading}>
          {submitLoading ? 'Signing up…' : 'Sign up'}
        </button>
      </form>
      <p>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </div>
  );
}
