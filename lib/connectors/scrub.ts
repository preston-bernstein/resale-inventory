// Shared credential-scrubbing utility used by every connector's error
// construction and every `recordSuspensionSignal` call to strip
// credential-bearing material before it reaches a thrown error, a log
// line, or a `reason` string.

const REDACTED = '[REDACTED]';

// Common object keys that indicate credential-bearing values, matched
// case-insensitively as a substring of the key name (e.g. 'apiKey',
// 'API_KEY', 'sessionCookie' all match 'key'/'cookie').
const DEFAULT_SECRET_KEY_HINTS = [
  'token',
  'secret',
  'password',
  'cookie',
  'authorization',
  'apikey',
  'api_key',
  'key',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of each non-empty secret value in `input`
 * with a fixed redaction marker. Safe to call with an empty, undefined,
 * or null-containing secrets list — those entries are simply skipped.
 */
export function scrubSecrets(input: string, secrets: (string | undefined | null)[]): string {
  if (!input || !secrets || secrets.length === 0) {
    return input;
  }

  let result = input;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    const pattern = new RegExp(escapeRegExp(secret), 'g');
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Defense-in-depth helper: returns a shallow-cloned copy of `obj` with
 * any key matching (case-insensitively) a known secret-key hint —
 * either one of the caller-supplied `secretKeys` or the built-in common
 * names like 'token', 'secret', 'password', 'cookie', 'authorization',
 * 'apiKey' — replaced with '[REDACTED]'. Use this when scrubbing a
 * whole object (e.g. before logging) without enumerating exact secret
 * values.
 */
export function scrubObjectSecrets<T extends Record<string, unknown>>(
  obj: T,
  secretKeys: string[] = []
): T {
  const lowerCustomKeys = secretKeys.map((k) => k.toLowerCase());
  const clone = { ...obj } as Record<string, unknown>;

  for (const key of Object.keys(clone)) {
    const lowerKey = key.toLowerCase();
    const isSecret =
      lowerCustomKeys.includes(lowerKey) ||
      DEFAULT_SECRET_KEY_HINTS.some((hint) => lowerKey.includes(hint));
    if (isSecret) {
      clone[key] = REDACTED;
    }
  }

  return clone as T;
}
