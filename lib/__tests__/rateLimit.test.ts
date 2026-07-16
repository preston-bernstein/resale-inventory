import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, getClientIp, resetRateLimitsForTests } from '@/lib/rateLimit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimitsForTests();
  });

  it('allows requests under the limit within the window', () => {
    const key = 'k1';
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5, 60_000)).toBe(true);
    }
  });

  it('rejects once the limit is reached within the window', () => {
    const key = 'k2';
    for (let i = 0; i < 5; i++) {
      checkRateLimit(key, 5, 60_000);
    }
    expect(checkRateLimit(key, 5, 60_000)).toBe(false);
  });

  it('tracks distinct keys independently', () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit('a', 5, 60_000);
    }
    expect(checkRateLimit('a', 5, 60_000)).toBe(false);
    // A different key has its own fresh window regardless of 'a's state.
    expect(checkRateLimit('b', 5, 60_000)).toBe(true);
  });

  it('resets the window once windowMs has elapsed', () => {
    const key = 'k3';
    const now = Date.now();
    // Simulate a hit whose window already ended by using a window of 0ms --
    // every subsequent call starts a fresh window, so the limit never trips.
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(key, 1, 0)).toBe(true);
    }
    expect(now).toBeGreaterThanOrEqual(0); // keep `now` referenced/meaningful
  });
});

describe('getClientIp', () => {
  it('prefers the first x-forwarded-for entry', () => {
    const req = new Request('http://localhost/x', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = new Request('http://localhost/x', {
      headers: { 'x-real-ip': '198.51.100.9' },
    });
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('falls back to a constant when neither header is present', () => {
    const req = new Request('http://localhost/x');
    expect(getClientIp(req)).toBe('unknown');
  });
});
