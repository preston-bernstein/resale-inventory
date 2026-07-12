'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

interface PhoneSessionItem {
  id: string;
  title: string;
  brand: string;
  size_label: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; item: PhoneSessionItem };

// Dead-end, chrome-free page loaded from a QR/link handed to whoever is
// physically holding the item. No links to any other route in the app
// (req 9/10) — the global site nav is suppressed for /phone/* routes by
// components/SiteChrome.tsx, and this component itself never renders one.
export default function PhonePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/phone-session/${token}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (!cancelled) {
            setState({ status: 'error', message: data.error ?? 'This link is no longer valid.' });
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setState({ status: 'ready', item: data.item });
        }
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: 'This link is no longer valid.' });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleUpload() {
    if (state.status !== 'ready') return;
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setFeedback({ kind: 'error', message: 'Choose at least one photo.' });
      return;
    }

    setUploading(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      for (const file of Array.from(files)) formData.append('files', file);

      const res = await fetch(`/api/items/${state.item.id}/photos`, {
        method: 'POST',
        headers: { 'X-Pairing-Token': token },
        body: formData,
      });

      if (res.ok) {
        setFeedback({ kind: 'success', message: `${files.length} photo(s) uploaded.` });
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        const message = await res
          .json()
          .then((data) => (typeof data?.error === 'string' ? data.error : 'Upload failed.'))
          .catch(() => 'Upload failed.');
        setFeedback({ kind: 'error', message });
      }
    } catch {
      setFeedback({ kind: 'error', message: 'Network error. Upload failed.' });
    } finally {
      setUploading(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <p className="text-gray-500">Loading…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <p className="text-center text-red-600 dark:text-red-400 text-lg">{state.message}</p>
      </div>
    );
  }

  const { item } = state;

  return (
    <div className="min-h-screen max-w-md mx-auto px-4 py-6 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{item.title}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">{item.brand}</p>
        <p className="text-gray-600 dark:text-gray-400">Size {item.size_label}</p>
      </div>

      <div className="flex flex-col gap-3">
        <label
          htmlFor="phone-photo-input"
          className="w-full text-center px-4 py-4 rounded-lg bg-blue-600 text-white text-lg font-medium active:bg-blue-700"
        >
          Take / choose photos
        </label>
        <input
          id="phone-photo-input"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
        />

        <button
          type="button"
          onClick={() => void handleUpload()}
          disabled={uploading}
          className="w-full px-4 py-4 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-lg font-medium disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>

        {feedback && (
          <p
            className={
              feedback.kind === 'success'
                ? 'text-green-700 dark:text-green-400 text-center'
                : 'text-red-600 dark:text-red-400 text-center'
            }
          >
            {feedback.message}
          </p>
        )}
      </div>
    </div>
  );
}
