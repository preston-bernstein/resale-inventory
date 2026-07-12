'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Photo } from '@/lib/types';

interface PhoneHandoffProps {
  itemId: string;
  onPhotosChange: (photos: Photo[]) => void;
}

// Top-level status; the finer-grained 'waiting' / 'connected' / 'ended' /
// 'expired' sub-states reported by the poll endpoint live in PollStatus
// below and only apply while status === 'qr-shown'.
type Status = 'idle' | 'loading' | 'qr-shown' | 'error';

// Sub-state reported by the poll endpoint while status === 'qr-shown'.
// null before the first poll response comes back.
type PollStatus = 'none' | 'waiting' | 'connected' | 'ended' | 'expired' | null;

const POLL_INTERVAL_MS = 3000;

export default function PhoneHandoff({ itemId, onPhotosChange }: PhoneHandoffProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [pollStatus, setPollStatus] = useState<PollStatus>(null);

  // Poll GET /api/items/[id]/phone-session every 3s while the QR is shown.
  // Stops (interval cleared) on unmount or once the polled status becomes
  // a terminal state ('ended' | 'expired'), at which point the component
  // resets back to idle so the operator can start a new session.
  useEffect(() => {
    if (status !== 'qr-shown') return;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/items/${itemId}/phone-session`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          onPhotosChange(data.photos);
          setPollStatus(data.status);
          if (data.status === 'ended' || data.status === 'expired') {
            resetToIdle();
          }
        }
      } catch {
        // Transient poll failures are ignored; the next tick retries.
      }
    }

    const id = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // onPhotosChange intentionally excluded below: including it would
    // restart the interval (and re-fire an immediate poll) on every parent
    // re-render it causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, itemId]);

  function resetToIdle() {
    setStatus('idle');
    setUrl('');
    setQrDataUrl('');
    setExpiresAt(null);
    setPollStatus(null);
  }

  async function handleEndSession() {
    try {
      await fetch(`/api/items/${itemId}/phone-session`, { method: 'DELETE' });
    } catch {
      // Idempotent on the server either way; reset locally regardless.
    }
    resetToIdle();
  }

  async function handleStart() {
    setStatus('loading');
    setError('');
    try {
      const res = await fetch(`/api/items/${itemId}/phone-session`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const dataUrl = await QRCode.toDataURL(data.url);
        setUrl(data.url);
        setQrDataUrl(dataUrl);
        setExpiresAt(data.expires_at);
        setStatus('qr-shown');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Error ${res.status}`);
        setStatus('error');
      }
    } catch {
      setError('Something went wrong — try again.');
      setStatus('error');
    }
  }

  if (status === 'qr-shown') {
    return (
      <div className="space-y-3" data-expires-at={expiresAt ?? undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a
            client-generated data: URL, not an optimizable next/image src */}
        <img src={qrDataUrl} alt="QR code to continue on phone" width={200} height={200} />
        <div className="space-y-1">
          <label htmlFor="phone-handoff-url" className="block text-xs text-gray-600 dark:text-gray-400">
            Or open this link on your phone:
          </label>
          <input
            id="phone-handoff-url"
            type="text"
            readOnly
            value={url}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-xs bg-gray-50 dark:bg-gray-800 dark:text-gray-200"
          />
        </div>
        {pollStatus === 'waiting' && (
          <p className="text-xs text-gray-600 dark:text-gray-400">Waiting for phone to scan…</p>
        )}
        {pollStatus === 'connected' && (
          <p className="text-xs text-gray-600 dark:text-gray-400">Phone connected</p>
        )}
        <button
          type="button"
          onClick={() => { void handleEndSession(); }}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
        >
          End session
        </button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => { void handleStart(); }}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { void handleStart(); }}
      disabled={status === 'loading'}
      className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
    >
      {status === 'loading' ? 'Starting…' : 'Continue on phone'}
    </button>
  );
}
