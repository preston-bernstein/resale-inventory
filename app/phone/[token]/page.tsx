'use client';

import { useParams } from 'next/navigation';
import PhoneUploadView from './PhoneUploadView';
import { usePhoneSession } from './usePhoneSession';
import { usePhoneUpload } from './usePhoneUpload';

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center px-4">{children}</div>;
}

// Dead-end, chrome-free page loaded from a QR/link handed to whoever is
// physically holding the item. No links to any other route in the app
// (req 9/10) — the global site nav is suppressed for /phone/* routes by
// components/SiteChrome.tsx, and this component itself never renders one.
export default function PhonePage() {
  const { token } = useParams<{ token: string }>();
  const state = usePhoneSession(token);
  const { fileInputRef, uploading, feedback, upload } = usePhoneUpload(
    token,
    state.status === 'ready' ? state.item.id : null,
  );

  if (state.status === 'loading') {
    return (
      <CenteredMessage>
        <p className="text-gray-500">Loading…</p>
      </CenteredMessage>
    );
  }

  if (state.status === 'error') {
    return (
      <CenteredMessage>
        <p className="text-center text-red-600 dark:text-red-400 text-lg">{state.message}</p>
      </CenteredMessage>
    );
  }

  return (
    <PhoneUploadView
      item={state.item}
      fileInputRef={fileInputRef}
      uploading={uploading}
      feedback={feedback}
      onUpload={() => void upload()}
    />
  );
}
