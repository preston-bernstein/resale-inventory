import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enforcePacing } from '@/lib/connectors/pacing';
import { resetRateLimitsForTests } from '@/lib/rateLimit';
import { ConnectorRateLimitedError } from '@/lib/connectors/types';
import { DEPOP_ACTION_RATE_LIMIT_MS } from '@/lib/constants';

describe('enforcePacing', () => {
  beforeEach(() => {
    // enforcePacing shares lib/rateLimit.ts's module-level bucket map with
    // every other connector, so state must be reset between tests --
    // otherwise an earlier test's paced action would leak into this one.
    resetRateLimitsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first action for a connection', () => {
    expect(() => enforcePacing('depop', 'conn-1')).not.toThrow();
  });

  it('rejects a second action for the same connection within the window', () => {
    enforcePacing('depop', 'conn-1');
    expect(() => enforcePacing('depop', 'conn-1')).toThrow(ConnectorRateLimitedError);
  });

  it('paces per-connection, not globally -- a different connectionId is unaffected', () => {
    enforcePacing('depop', 'conn-1');
    expect(() => enforcePacing('depop', 'conn-1')).toThrow(ConnectorRateLimitedError);

    // A different connection for the same platform has its own bucket
    // (key is `${platform}:${connectionId}`), so it must not be blocked by
    // conn-1's already-paced action.
    expect(() => enforcePacing('depop', 'conn-2')).not.toThrow();
  });

  it('allows another action once the window has elapsed', () => {
    // lib/rateLimit.ts's checkRateLimit keys its fixed window off
    // Date.now(), so vitest's fake timers (which mock Date.now() too) are a
    // clean way to simulate window-reset without waiting 10s in real time.
    vi.useFakeTimers();

    expect(() => enforcePacing('depop', 'conn-1')).not.toThrow();
    expect(() => enforcePacing('depop', 'conn-1')).toThrow(ConnectorRateLimitedError);

    vi.advanceTimersByTime(DEPOP_ACTION_RATE_LIMIT_MS);

    expect(() => enforcePacing('depop', 'conn-1')).not.toThrow();
  });
});
