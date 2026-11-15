// Shows the outcome of the Etsy OAuth callback (`?etsy=<code>` on /connections).
// Unknown codes render nothing, so a crafted URL can't inject text.
const ETSY_RESULT_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Etsy account linked.' },
  denied: { ok: false, text: 'You declined access on Etsy. Nothing was linked.' },
  shop_not_found: { ok: false, text: 'That Etsy account has no shop, so nothing was linked.' },
  connector_not_configured: { ok: false, text: 'Etsy is not set up on this server yet.' },
  token_exchange_failed: { ok: false, text: 'Etsy could not finish linking. Try again.' },
  shop_lookup_failed: { ok: false, text: 'Etsy could not finish linking. Try again.' },
  connection_not_found: { ok: false, text: 'That connection no longer exists.' },
};

export default function EtsyResultBanner({ result }: { result?: string }) {
  const message =
    result && Object.hasOwn(ETSY_RESULT_MESSAGES, result) ? ETSY_RESULT_MESSAGES[result] : undefined;
  if (!message) return null;
  return (
    <p
      data-testid="etsy-result"
      role="status"
      className={`text-sm mb-3 ${message.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
    >
      {message.text}
    </p>
  );
}
