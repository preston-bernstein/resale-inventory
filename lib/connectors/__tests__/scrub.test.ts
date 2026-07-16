import { describe, it, expect } from 'vitest';
import { scrubSecrets, scrubObjectSecrets } from '../scrub';

describe('scrubSecrets', () => {
  it('replaces a secret occurrence with the redaction marker', () => {
    const result = scrubSecrets('Error: token abc123XYZ was rejected', ['abc123XYZ']);
    expect(result.includes('abc123XYZ')).toBe(false);
    expect(result).toContain('[REDACTED]');
  });

  it('returns the input unchanged when secrets list is empty or undefined', () => {
    const input = 'Error: token abc123XYZ was rejected';
    expect(scrubSecrets(input, [])).toBe(input);
    expect(scrubSecrets(input, [undefined, null])).toBe(input);
  });

  it('scrubs every occurrence of a secret that appears multiple times', () => {
    const input = 'first sekrit123 then again sekrit123 and once more sekrit123';
    const result = scrubSecrets(input, ['sekrit123']);
    expect(result.includes('sekrit123')).toBe(false);
    expect(result.split('[REDACTED]').length - 1).toBe(3);
  });

  it('returns the empty-string input unchanged, never touching the secrets list', () => {
    expect(scrubSecrets('', ['whatever'])).toBe('');
  });

  it('returns input unchanged (without throwing) when secrets itself is null or undefined, not just when it is []', () => {
    // The guard is `!input || !secrets || secrets.length === 0` -- a
    // mutant that drops or short-circuits the `!secrets` check
    // differently would instead fall through to `secrets.length` (or a
    // `for...of secrets` loop) on a null/undefined secrets list and throw,
    // rather than returning input unchanged like the empty-array case
    // above already covers.
    const input = 'nothing secret here';
    expect(scrubSecrets(input, null as unknown as (string | undefined | null)[])).toBe(input);
    expect(scrubSecrets(input, undefined as unknown as (string | undefined | null)[])).toBe(
      input,
    );
  });

  it('secret at the very start, in the middle, and at the very end of the string are all redacted', () => {
    expect(scrubSecrets('SEKRIT is at the start', ['SEKRIT'])).toBe('[REDACTED] is at the start');
    expect(scrubSecrets('a SEKRIT in the middle', ['SEKRIT'])).toBe('a [REDACTED] in the middle');
    expect(scrubSecrets('ends with SEKRIT', ['SEKRIT'])).toBe('ends with [REDACTED]');
  });

  it('is case-sensitive: a secret with different casing than the source text is NOT redacted', () => {
    const result = scrubSecrets('Token: AbCdEf123', ['abcdef123']);
    expect(result).toBe('Token: AbCdEf123');
    expect(result).not.toContain('[REDACTED]');
  });

  it('redacts multiple distinct secret values within a single call', () => {
    const result = scrubSecrets('user=alice token=tok_1 pass=hunter2', ['tok_1', 'hunter2']);
    expect(result).toBe('user=alice token=[REDACTED] pass=[REDACTED]');
  });

  it('treats regex-special characters in a secret value literally, not as a pattern', () => {
    const result = scrubSecrets('key: a.b+c*d', ['a.b+c*d']);
    expect(result).toBe('key: [REDACTED]');
    // Sanity check the escaping actually matters -- an UNRELATED string
    // that would match `a.b+c*d` if the dot/plus/star were live regex
    // metacharacters must NOT be redacted.
    expect(scrubSecrets('key: aXbccccd', ['a.b+c*d'])).toBe('key: aXbccccd');
  });
});

describe('scrubObjectSecrets', () => {
  it('replaces keys in secretKeys with the redaction marker, leaving others untouched', () => {
    const result = scrubObjectSecrets({ token: 'sekrit', name: 'ok' }, ['token']);
    expect(result).toEqual({ token: '[REDACTED]', name: 'ok' });
  });

  it('matches a custom secretKeys entry case-insensitively against the object key (both directions)', () => {
    // 'FOOBAR' contains none of the built-in DEFAULT_SECRET_KEY_HINTS, so
    // this can only be redacted via the custom-key path -- proving both
    // the object key AND the custom key are actually lowercased before
    // comparison (not just one side, and not comparing raw case).
    const result = scrubObjectSecrets({ fooBar: 'x', other: 'y' }, ['FOOBAR']);
    expect(result).toEqual({ fooBar: '[REDACTED]', other: 'y' });
  });

  it('redacts a key via a DEFAULT_SECRET_KEY_HINTS match alone, with no secretKeys argument at all', () => {
    // No custom secretKeys passed -- this can only be redacted via the
    // built-in default-hints path, isolating it from the custom-key
    // check.
    const result = scrubObjectSecrets({ password: 'hunter2', name: 'ok' });
    expect(result).toEqual({ password: '[REDACTED]', name: 'ok' });
  });

  it('leaves near-miss keys that do NOT actually contain any secret hint untouched', () => {
    const result = scrubObjectSecrets({
      username: 'alice',
      email: 'a@example.com',
      nickname: 'al',
    });
    expect(result).toEqual({
      username: 'alice',
      email: 'a@example.com',
      nickname: 'al',
    });
  });

  it('matches a hint as a case-insensitive SUBSTRING of the key, not just an exact key name', () => {
    // 'apiToken' contains 'token' as a substring but isn't itself in
    // DEFAULT_SECRET_KEY_HINTS -- proving substring matching (not exact
    // equality) is what's doing the work.
    const result = scrubObjectSecrets({ apiToken: 'sekrit', apiCallCount: 3 });
    expect(result).toEqual({ apiToken: '[REDACTED]', apiCallCount: 3 });
  });

  it('the secretKeys default (omitted argument) behaves as an empty list, not as if some placeholder key were implicitly secret', () => {
    const result = scrubObjectSecrets({ 'stryker was here': 'x', name: 'ok' });
    expect(result).toEqual({ 'stryker was here': 'x', name: 'ok' });
  });

  it('does not mutate the original object -- returns a distinct shallow clone', () => {
    const original = { token: 'sekrit', name: 'ok' };
    const result = scrubObjectSecrets(original, ['token']);
    expect(result).not.toBe(original);
    expect(original.token).toBe('sekrit');
  });
});
