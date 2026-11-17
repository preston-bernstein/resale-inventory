/** Assigns `value.trim()` under `key` only when non-blank. */
export function assignTrimmed(body: Record<string, unknown>, key: string, rawValue: string): void {
  const trimmed = rawValue.trim();
  if (trimmed) body[key] = trimmed;
}

/** Parses a raw numeric field and assigns it under `key` only when non-blank and parseable — silently omitted otherwise. */
export function assignOptionalNumber(
  body: Record<string, unknown>,
  key: string,
  rawValue: string,
  parser: (s: string) => number,
): void {
  if (rawValue.trim() === '') return;
  const parsed = parser(rawValue);
  if (!isNaN(parsed)) body[key] = parsed;
}

export const parseDecimalInt = (s: string): number => parseInt(s, 10);
