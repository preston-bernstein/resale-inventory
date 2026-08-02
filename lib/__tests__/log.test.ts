import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from '@/lib/log';

describe('logEvent', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  function lastLoggedLine(): Record<string, unknown> {
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const [arg] = consoleLogSpy.mock.calls[0] as [string];
    return JSON.parse(arg) as Record<string, unknown>;
  }

  it('emits exactly one line to console.log (not console.error), as valid JSON', () => {
    logEvent('info', 'test.event', 'a message');

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const [arg] = consoleLogSpy.mock.calls[0] as [string];
    expect(() => JSON.parse(arg)).not.toThrow();
  });

  it('includes every field the fleet logging contract (CONVENTIONS.md #18) requires', () => {
    logEvent('warn', 'forward_auth.verification_failed', 'Authentik JWT verification failed', {
      run_id: 'run-123',
    });

    const line = lastLoggedLine();
    expect(line.schema_version).toBe(1);
    expect(line.level).toBe('warn');
    expect(line.service).toBe('internal-inventory-app');
    expect(line.event).toBe('forward_auth.verification_failed');
    expect(line.msg).toBe('Authentik JWT verification failed');
    expect(line.run_id).toBe('run-123');
    expect(typeof line.ts).toBe('string');
    // RFC3339 UTC, second precision (no milliseconds) -- matches
    // CONVENTIONS.md #18's worked example exactly.
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('passes through arbitrary caller-supplied fields', () => {
    logEvent('error', 'test.event', 'msg', { reason: 'jwks_unreachable', key_id: 'abc-123' });

    const line = lastLoggedLine();
    expect(line.reason).toBe('jwks_unreachable');
    expect(line.key_id).toBe('abc-123');
  });

  it.each(['password', 'token', 'secret', 'authorization', 'cookie', 'session', 'api_key'])(
    'redacts a field named %s (case-insensitively) rather than logging its raw value',
    (fieldName) => {
      logEvent('error', 'test.event', 'msg', {
        [fieldName]: 'super-secret-value',
        [fieldName.toUpperCase()]: 'super-secret-value-upper',
      });

      const line = lastLoggedLine();
      expect(line[fieldName]).toBe('[REDACTED]');
      expect(line[fieldName.toUpperCase()]).toBe('[REDACTED]');
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain('super-secret-value');
    },
  );

  it('does not redact a field whose name merely contains a deny-listed substring but is not an exact match', () => {
    // "keyId"/"key_id" (a public JWKS key identifier) must survive -- only
    // exact deny-list matches redact, or every log call in this codebase
    // touching anything named similarly to a secret would be neutered.
    logEvent('warn', 'test.event', 'msg', { key_id: 'test-signing-key' });

    const line = lastLoggedLine();
    expect(line.key_id).toBe('test-signing-key');
  });

  it('defaults fields to an empty object when omitted', () => {
    logEvent('debug', 'test.event', 'msg');

    const line = lastLoggedLine();
    expect(line).toMatchObject({ schema_version: 1, level: 'debug', event: 'test.event' });
  });
});
