'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface AuthErrorData {
  error?: string;
  fields?: string[];
}

interface UseAuthFormArgs {
  endpoint: string;
  successStatus: number;
  errorMessage: (status: number, data: AuthErrorData) => string;
}

/**
 * Shared submit/fetch/redirect/error-handling boilerplate for the login and
 * signup pages — same shape as useSubmitItemForm, parameterized by endpoint,
 * success status, and per-status error message since login/signup diverge
 * only in those three things.
 */
export function useAuthForm({ endpoint, successStatus, errorMessage }: UseAuthFormArgs) {
  const router = useRouter();

  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');

  async function submit(email: string, password: string) {
    setSubmitError('');
    setSubmitLoading(true);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (res.status === successStatus) {
        router.push('/inventory');
        return;
      }

      const data = await res.json().catch(() => ({}));
      setSubmitError(errorMessage(res.status, data));
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  return { submitLoading, submitError, submit };
}
