/**
 * Validate weight_oz against the DB CHECK constraint:
 *   weight_oz IS NULL OR (weight_oz >= 0 AND weight_oz = CAST(weight_oz AS INTEGER))
 *
 * weight_oz is optional per FR12, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateWeightOz(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value >= 0 && Number.isInteger(value);
}

/**
 * Allowlist of clothing_details measurement columns, per FR5 / plan.md.
 */
export const CLOTHING_MEASUREMENT_FIELDS = [
  'pit_to_pit_in',
  'length_in',
  'sleeve_length_in',
  'waist_in',
  'rise_in',
  'inseam_in',
  'leg_opening_in',
  'hip_in',
] as const;

export type ClothingMeasurementField = (typeof CLOTHING_MEASUREMENT_FIELDS)[number];

/**
 * Validate a single measurement field value, per FR5: all 8 measurement
 * fields are optional at creation, so null/undefined is valid; if provided,
 * the value must be a non-negative real number (integer or float).
 */
export function validateMeasurement(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value >= 0;
}

/**
 * Validate gender_department. Per FR11 it is free text with no fixed
 * vocabulary, so any string (or absence) is valid — this only rejects
 * values of the wrong type (e.g. a number or object).
 */
export function validateGenderDepartment(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return typeof value === 'string';
}
