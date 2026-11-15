'use client';

import { useState } from 'react';

// Etsy needs a one-time browser consent (OAuth + PKCE). The server returns
// the Etsy URL; the callback route brings the user back to /connections.
export default function EtsyLinkButton({ connectionId }: { connectionId: string }) {
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function handleLinkEtsy() {
    setLinking(true);
    setLinkError(null);
    try {
      const res = await fetch(`/api/connections/${connectionId}/etsy/authorize`, {
        method: 'POST',
      });
      if (res.status === 503) {
        setLinkError('Etsy is not set up on this server yet (missing API key or redirect URI).');
        return;
      }
      if (!res.ok) {
        setLinkError(`Could not start Etsy linking (HTTP ${res.status}).`);
        return;
      }
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      window.location.assign(authorizeUrl);
    } catch (err) {
      console.error('handleLinkEtsy failed:', err);
      setLinkError('Could not start Etsy linking -- check your connection and try again.');
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void handleLinkEtsy()}
        disabled={linking}
        className="text-xs px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Link Etsy account
      </button>
      {linkError && (
        <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {linkError}
        </span>
      )}
    </div>
  );
}
