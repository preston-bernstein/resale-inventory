// Self-pacing for platforms with no published rate-limit policy (Depop,
// Mercari, Vinted, Grailed -- see lib/constants.ts comment on the
// *_ACTION_RATE_LIMIT_MS constants for why these are conservative defaults
// rather than documented thresholds like Poshmark's cooldown/share-cap).
//
// Reuses lib/rateLimit.ts's existing fixed-window in-memory limiter rather
// than introducing a second rate-limiting mechanism -- same tradeoffs apply
// here (process-local state, cleared on restart). Each connection gets its
// own bucket (keyed `${platform}:${connectionId}`) so pacing one connection
// never blocks another connection's actions on the same platform.

import { checkRateLimit } from '@/lib/rateLimit';
import {
  DEPOP_ACTION_RATE_LIMIT_MS,
  MERCARI_ACTION_RATE_LIMIT_MS,
  VINTED_ACTION_RATE_LIMIT_MS,
  GRAILED_ACTION_RATE_LIMIT_MS,
  SWAPPA_ACTION_RATE_LIMIT_MS,
} from '@/lib/constants';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';

export type PacedPlatform = 'depop' | 'mercari' | 'vinted' | 'grailed' | 'swappa';

const PACING_WINDOW_MS: Record<PacedPlatform, number> = {
  depop: DEPOP_ACTION_RATE_LIMIT_MS,
  mercari: MERCARI_ACTION_RATE_LIMIT_MS,
  vinted: VINTED_ACTION_RATE_LIMIT_MS,
  grailed: GRAILED_ACTION_RATE_LIMIT_MS,
  swappa: SWAPPA_ACTION_RATE_LIMIT_MS,
};

/**
 * Enforces "1 action per {platform}'s window" pacing for a given connection.
 * Throws `ConnectorRateLimitedError` if another action was already taken
 * for this platform+connection within the current window; otherwise
 * records this action and returns normally.
 */
export function enforcePacing(platform: PacedPlatform, connectionId: string): void {
  const windowMs = PACING_WINDOW_MS[platform];
  const key = `${platform}:${connectionId}`;

  // limit=1: at most one paced action per connection per window.
  const allowed = checkRateLimit(key, 1, windowMs);
  if (!allowed) {
    throw new ConnectorRateLimitedError(platform, connectionId);
  }
}
