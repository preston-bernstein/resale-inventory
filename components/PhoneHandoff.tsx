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

const BUTTON_CLASS =
  'border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200';

interface QrSession {
  url: string;
  qrDataUrl: string;
  expiresAt: number | null;
}

const NO_SESSION: QrSession = { url: '', qrDataUrl: '', expiresAt: null };

interface PollResult {
  photos: Photo[];
  status: PollStatus;
}

async function fetchPollResult(itemId: string): Promise<PollResult | null> {
  const res = await fetch(`/api/items/${itemId}/phone-session`);
  return res.ok ? await res.json() : null;
}

function isTerminal(status: PollStatus): boolean {
  return status === 'ended' || status === 'expired';
}

// Keeps the newest value in a ref so a new callback from the parent does not
// restart the poll interval (and re-fire an immediate poll) on every render.
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

// Poll GET /api/items/[id]/phone-session every 3s while the QR is shown.
// Stops (interval cleared) on unmount or once the polled status becomes a
// terminal state ('ended' | 'expired'), at which point `onTerminal` resets
// the component back to idle so the operator can start a new session.
function usePhonePoll(
  active: boolean,
  itemId: string,
  onPhotosChange: (photos: Photo[]) => void,
  onTerminal: () => void,
) {
  const [pollStatus, setPollStatus] = useState<PollStatus>(null);
  const onPhotosChangeRef = useLatest(onPhotosChange);
  const onTerminalRef = useLatest(onTerminal);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    async function poll() {
      try {
        const result = await fetchPollResult(itemId);
        if (cancelled || !result) return;
        onPhotosChangeRef.current(result.photos);
        setPollStatus(result.status);
        if (isTerminal(result.status)) onTerminalRef.current();
      } catch {
        // Transient poll failures are ignored; the next tick retries.
      }
    }

    const id = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, itemId, onPhotosChangeRef, onTerminalRef]);

  // Leaving the QR view (end, terminal status or error) clears the sub-state.
  useEffect(() => {
    if (!active) setPollStatus(null);
  }, [active]);

  return pollStatus;
}

async function endSession(itemId: string): Promise<void> {
  try {
    await fetch(`/api/items/${itemId}/phone-session`, { method: 'DELETE' });
  } catch {
    // Idempotent on the server either way; the caller resets locally regardless.
  }
}

type StartResult = { ok: true; session: QrSession } | { ok: false; error: string };

async function startSession(itemId: string): Promise<StartResult> {
  try {
    const res = await fetch(`/api/items/${itemId}/phone-session`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error ?? `Error ${res.status}` };
    }
    const data = await res.json();
    const qrDataUrl = await QRCode.toDataURL(data.url);
    return { ok: true, session: { url: data.url, qrDataUrl, expiresAt: data.expires_at } };
  } catch {
    return { ok: false, error: 'Something went wrong — try again.' };
  }
}

function QrPanel({
  session,
  pollStatus,
  onEnd,
}: {
  session: QrSession;
  pollStatus: PollStatus;
  onEnd: () => void;
}) {
  return (
    <div className="space-y-3" data-expires-at={session.expiresAt ?? undefined}>
      <Image src={session.qrDataUrl} alt="QR code to continue on phone" width={200} height={200} unoptimized />
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
      <button type="button" onClick={onEnd} className={BUTTON_CLASS}>
        End session
      </button>
    </div>
  );
}

function StartError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-red-600 dark:text-red-400">{message}</p>
      <button type="button" onClick={onRetry} className={BUTTON_CLASS}>
        Try again
      </button>
    </div>
  );
}

export default function PhoneHandoff({ itemId, onPhotosChange }: PhoneHandoffProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [session, setSession] = useState<QrSession>(NO_SESSION);

  const resetToIdle = useCallback(() => {
    setStatus('idle');
    setSession(NO_SESSION);
  }, []);
  const pollStatus = usePhonePoll(status === 'qr-shown', itemId, onPhotosChange, resetToIdle);

  async function handleEndSession() {
    await endSession(itemId);
    resetToIdle();
  }

  async function handleStart() {
    setStatus('loading');
    setError('');
    const result = await startSession(itemId);
    if (result.ok) {
      setSession(result.session);
      setStatus('qr-shown');
    } else {
      setError(result.error);
      setStatus('error');
    }
  }

  if (status === 'qr-shown') {
    return <QrPanel session={session} pollStatus={pollStatus} onEnd={() => { void handleEndSession(); }} />;
  }

  if (status === 'error') {
    return <StartError message={error} onRetry={() => { void handleStart(); }} />;
  }

  return (
    <button
      type="button"
      onClick={() => { void handleStart(); }}
      disabled={status === 'loading'}
      className={`${BUTTON_CLASS} disabled:opacity-50`}
    >
      {status === 'loading' ? 'Starting…' : 'Continue on phone'}
    </button>
  );
}
