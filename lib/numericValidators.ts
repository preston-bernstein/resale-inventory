/**
 * Shared shape behind every "optional numeric field" validator in this app
 * (clothing measurements, electronics specs): absence (null/undefined) is
 * always valid since these fields are optional; a present value must be a
 * finite number satisfying the field's own range/integer rule.
 */
export function validateOptionalNumber(value: unknown, isValid: (n: number) => boolean): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return isValid(value);
}
