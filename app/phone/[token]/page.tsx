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

async function loadPhoneSession(token: string): Promise<LoadState> {
  try {
    const res = await fetch(`/api/phone-session/${token}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { status: 'error', message: data.error ?? 'This link is no longer valid.' };
    }
    const data = await res.json();
    return { status: 'ready', item: data.item };
  } catch (err) {
    console.error('phone-session load failed:', err);
    return { status: 'error', message: 'This link is no longer valid.' };
  }
}

function usePhoneSessionState(token: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void loadPhoneSession(token).then((loaded) => {
      if (!cancelled) setState(loaded);
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}

type Feedback = { kind: 'success' | 'error'; message: string } | null;

async function uploadPhotos(itemId: string, token: string, files: File[]): Promise<Feedback> {
  const formData = new FormData();
  for (const file of files) formData.append('files', file);

  const res = await fetch(`/api/items/${itemId}/photos`, {
    method: 'POST',
    headers: { 'X-Pairing-Token': token },
    body: formData,
  });

  if (res.ok) {
    return { kind: 'success', message: `${files.length} photo(s) uploaded.` };
  }

  const message = await res
    .json()
    .then((data) => (typeof data?.error === 'string' ? data.error : 'Upload failed.'))
    .catch(() => 'Upload failed.');
  return { kind: 'error', message };
}

function usePhotoUpload(token: string, state: LoadState) {
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const result = await uploadPhotos(state.item.id, token, Array.from(files));
      setFeedback(result);
      if (result?.kind === 'success' && fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error('handleUpload failed:', err);
      setFeedback({ kind: 'error', message: 'Network error. Upload failed.' });
    } finally {
      setUploading(false);
    }
  }

  return { uploading, feedback, fileInputRef, handleUpload };
}

interface CenteredMessageProps {
  children: React.ReactNode;
}

function CenteredScreen({ children }: CenteredMessageProps) {
  return <div className="min-h-screen flex items-center justify-center px-4">{children}</div>;
}

// Dead-end, chrome-free page loaded from a QR/link handed to whoever is
// physically holding the item. No links to any other route in the app
// (req 9/10) — the global site nav is suppressed for /phone/* routes by
// components/SiteChrome.tsx, and this component itself never renders one.
export default function PhonePage() {
  const { token } = useParams<{ token: string }>();
  const state = usePhoneSessionState(token);
  const upload = usePhotoUpload(token, state);

  if (state.status === 'loading') {
    return (
      <CenteredScreen>
        <p className="text-gray-500">Loading…</p>
      </CenteredScreen>
    );
  }

  if (state.status === 'error') {
    return (
      <CenteredScreen>
        <p className="text-center text-red-600 dark:text-red-400 text-lg">{state.message}</p>
      </CenteredScreen>
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

      <UploadControls upload={upload} />
    </div>
  );
}

function UploadControls({ upload }: { upload: ReturnType<typeof usePhotoUpload> }) {
  const { uploading, feedback, fileInputRef, handleUpload } = upload;

  return (
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
        multiple={true}
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
  );
}
