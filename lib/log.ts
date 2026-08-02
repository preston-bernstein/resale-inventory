// Minimal structured logger conforming to the fleet's shared logging
// contract (internal-infra CONVENTIONS.md #18): one JSON object per line, to
// stdout, with the canonical field set. This module intentionally does NOT
// attempt to replace the repo's existing 34 `console.error` call sites (see
// the 2026-08-01 observability audit) -- that is a larger, separately
// tracked cleanup (audit gap "log-format", severity high, not the SSO
// fail-open defect this module was added to fix). It exists specifically so
// the forward-auth fail-closed fix (lib/forwardAuth.ts, middleware.ts) can
// emit a diagnosable, redaction-safe log line instead of adding another bare
// console.error.
//
// Library-vs-application note (CONVENTIONS.md #18): this file is imported by
// both middleware.ts (the application's own entry point) and would be a
// reasonable target for other route handlers later -- it never calls
// console.*'s underlying stream configuration itself (no
// process.stdout.write redirection, no third-party logger `configure()`
// call), it just formats and emits one line per call, so it's safe to import
// from anywhere without violating the "only the entry point configures
// output" rule.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

const SERVICE_NAME = 'internal-inventory-app';

// The redaction deny-list from CONVENTIONS.md #18. This is a defense-in-depth
// check on top of the shared Loki `stage.replace` backstop -- this app is not
// yet onboarded to Loki (see the 2026-08-01 audit's "log-shipping" gap), so
// there is no pipeline-side backstop live for it today, which makes this
// call-site check load-bearing rather than redundant until that onboarding
// ships.
const REDACTED_FIELD_NAMES = new Set([
  'password',
  'passwd',
  'token',
  'api_key',
  'apikey',
  'secret',
  'authorization',
  'access_token',
  'refresh_token',
  'ssn',
  'cookie',
  'session',
]);

export interface LogFields {
  [key: string]: unknown;
}

/**
 * Emit one canonical JSON log line to stdout.
 *
 * `fields` must never carry a token, cookie, Authorization header, or other
 * secret value -- see REDACTED_FIELD_NAMES above. A field whose name matches
 * the deny-list (case-insensitively, exact match) has its value replaced
 * with the literal string `"[REDACTED]"` rather than silently dropped, so a
 * caller who accidentally passes one still sees the field name (useful for
 * fixing the call site) without leaking the value.
 */
export function logEvent(
  level: LogLevel,
  event: string,
  msg: string,
  fields: LogFields = {},
): void {
  const safeFields: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safeFields[key] = REDACTED_FIELD_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }

  const line = {
    schema_version: 1,
    // RFC3339 UTC, second precision -- matches CONVENTIONS.md #18's worked
    // example exactly (toISOString()'s millisecond suffix is stripped).
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    level,
    service: SERVICE_NAME,
    event,
    msg,
    ...safeFields,
  };

  // console.log, not console.error, regardless of level -- StandardOutput
  // (not StandardError) is where the systemd unit routes stdout, and the
  // level field (not the stream) is what a Loki onboarding will key alerts
  // off once this service is onboarded (audit gap "log-shipping").
  console.log(JSON.stringify(line));
}
