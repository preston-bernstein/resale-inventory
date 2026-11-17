import { useEffect, useState } from 'react';

export interface PhoneSessionItem {
  id: string;
  title: string;
  brand: string;
  size_label: string;
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; item: PhoneSessionItem };

const INVALID_LINK_MESSAGE = 'This link is no longer valid.';

async function fetchSessionState(token: string): Promise<LoadState> {
  try {
    const res = await fetch(`/api/phone-session/${token}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { status: 'error', message: data.error ?? INVALID_LINK_MESSAGE };
    }
    const data = await res.json();
    return { status: 'ready', item: data.item };
  } catch (err) {
    console.error('phone-session load failed:', err);
    return { status: 'error', message: INVALID_LINK_MESSAGE };
  }
}

export function usePhoneSession(token: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetchSessionState(token).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}
