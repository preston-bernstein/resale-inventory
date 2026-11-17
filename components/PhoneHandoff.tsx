'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
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

interface PollHandlers {
  onPhotos: (photos: Photo[]) => void;
  onStatus: (status: PollStatus) => void;
  /** The session ended or expired, so the component resets back to idle. */
  onTerminal: () => void;
}

// Poll GET /api/items/[id]/phone-session every 3s while the QR is shown.
// Stops (interval cleared) on unmount or once the polled status becomes
// a terminal state ('ended' | 'expired'). The handlers live in a ref so a
// parent re-render that passes new callbacks does not restart the interval
// (and re-fire an immediate poll).
function useSessionPolling(active: boolean, itemId: string, handlers: PollHandlers) {
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/items/${itemId}/phone-session`);
        if (cancelled) return;
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        handlersRef.current.onPhotos(data.photos);
        handlersRef.current.onStatus(data.status);
        if (data.status === 'ended' || data.status === 'expired') {
          handlersRef.current.onTerminal();
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
  }, [active, itemId]);
}

interface NewSession {
  url: string;
  qrDataUrl: string;
  expiresAt: number;
}

type StartResult = { ok: true; session: NewSession } | { ok: false; error: string };

async function requestNewSession(itemId: string): Promise<StartResult> {
  const res = await fetch(`/api/items/${itemId}/phone-session`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? `Error ${res.status}` };
  }

  const data = await res.json();
  const qrDataUrl = await QRCode.toDataURL(data.url);
  return { ok: true, session: { url: data.url, qrDataUrl, expiresAt: data.expires_at } };
}

function usePhoneSession(itemId: string, onPhotosChange: (photos: Photo[]) => void) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [session, setSession] = useState<NewSession | null>(null);
  const [pollStatus, setPollStatus] = useState<PollStatus>(null);

  const resetToIdle = useCallback(() => {
    setStatus('idle');
    setSession(null);
    setPollStatus(null);
  }, []);

  useSessionPolling(status === 'qr-shown', itemId, {
    onPhotos: onPhotosChange,
    onStatus: setPollStatus,
    onTerminal: resetToIdle,
  });

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
      const result = await requestNewSession(itemId);
      if (!result.ok) {
        setError(result.error);
        setStatus('error');
        return;
      }
      setSession(result.session);
      setStatus('qr-shown');
    } catch {
      setError('Something went wrong — try again.');
      setStatus('error');
    }
  }

  return { status, error, session, pollStatus, handleStart, handleEndSession };
}

const SECONDARY_BUTTON_CLASS =
  'border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200';

interface QrPanelProps {
  session: NewSession;
  pollStatus: PollStatus;
  onEndSession: () => void;
}

function QrPanel({ session, pollStatus, onEndSession }: QrPanelProps) {
  return (
    <div className="space-y-3" data-expires-at={session.expiresAt ?? undefined}>
      <Image
        src={session.qrDataUrl}
        alt="QR code to continue on phone"
        width={200}
        height={200}
        unoptimized
      />
      <div className="space-y-1">
        <label htmlFor="phone-handoff-url" className="block text-xs text-gray-600 dark:text-gray-400">
          Or open this link on your phone:
        </label>
        <input
          id="phone-handoff-url"
          type="text"
          readOnly
          value={session.url}
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
      <button type="button" onClick={onEndSession} className={SECONDARY_BUTTON_CLASS}>
        End session
      </button>
    </div>
  );
}

export default function PhoneHandoff({ itemId, onPhotosChange }: PhoneHandoffProps) {
  const { status, error, session, pollStatus, handleStart, handleEndSession } = usePhoneSession(
    itemId,
    onPhotosChange,
  );

  if (status === 'qr-shown' && session) {
    return (
      <QrPanel
        session={session}
        pollStatus={pollStatus}
        onEndSession={() => { void handleEndSession(); }}
      />
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        <button type="button" onClick={() => { void handleStart(); }} className={SECONDARY_BUTTON_CLASS}>
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
      className={`${SECONDARY_BUTTON_CLASS} disabled:opacity-50`}
    >
      {status === 'loading' ? 'Starting…' : 'Continue on phone'}
    </button>
  );
}
