'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface FieldErrors {
  [key: string]: string;
}

interface SubmitArgs {
  /** Raw acquisition-cost input; parsed to integer cents before submit. */
  acquisitionCost: string;
  /** Builds the rest of the POST body once the cost has parsed cleanly. */
  buildBody: (acquisitionCostCents: number) => Record<string, unknown>;
}

/**
 * Shared submit/fetch/redirect/error-handling boilerplate for the "add
 * item" forms (AddBookForm, AddClothingForm). Both forms POST to the same
 * /api/items endpoint with the same success/422/error/network-failure
 * handling — only the request body shape differs, which is why `submit`
 * takes a `buildBody` callback rather than the body itself.
 */
export function useSubmitItemForm() {
  const router = useRouter();

  const [submitLoading, setSubmitLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');

  async function submit({ acquisitionCost, buildBody }: SubmitArgs) {
    setFieldErrors({});
    setSubmitError('');
    setSubmitLoading(true);

    const costCents = Math.round(parseFloat(acquisitionCost) * 100);
    if (isNaN(costCents)) {
      setFieldErrors({ acquisition_cost: 'Enter a valid dollar amount.' });
      setSubmitLoading(false);
      return;
    }

    const body = buildBody(costCents);

    try {
      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        router.push('/inventory');
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && data.fields) {
        setFieldErrors(data.fields);
      } else {
        setSubmitError(data.error ?? 'Submission failed.');
      }
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  return { submitLoading, fieldErrors, submitError, submit };
}
