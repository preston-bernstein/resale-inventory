import { validateOptionalNumber } from './numericValidators';

/**
 * Validate weight_oz against the DB CHECK constraint:
 *   weight_oz IS NULL OR (weight_oz >= 0 AND weight_oz = CAST(weight_oz AS INTEGER))
 *
 * weight_oz is optional per FR12, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateWeightOz(value: unknown): boolean {
  return validateOptionalNumber(value, (v) => v >= 0 && Number.isInteger(v));
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
  return validateOptionalNumber(value, (v) => v >= 0);
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

/**
 * Size system type: one of three closed vocabularies.
 */
export type SizeSystem = 'letter' | 'shoe' | 'numeric_waist_inseam';

/**
 * Closed vocabularies for each size system, per plan.md.
 * letter and shoe are fixed membership lists; numeric_waist_inseam is
 * validated by regex pattern (^\d{1,3}x\d{1,3}$), not membership.
 */
export const SIZE_SYSTEMS = {
  letter: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const,
  shoe: ['4', '4.5', '5', '5.5', '6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5', '13', '13.5', '14', '14.5', '15'] as const,
  numeric_waist_inseam: [] as const, // Regex-validated pattern, not membership
} as const;

/**
 * Validate size_system against the closed vocabulary of system names.
 * Per plan.md, size_system is one of: 'letter', 'shoe', or 'numeric_waist_inseam'.
 * Returns true only if value is an exact string match to one of these three.
 */
export function validateSizeSystem(value: unknown): boolean {
  return value === 'letter' || value === 'shoe' || value === 'numeric_waist_inseam';
}

/**
 * Validate a size label against a specific size system.
 * - For 'letter' and 'shoe': checks exact membership in SIZE_SYSTEMS (case-sensitive).
 * - For 'numeric_waist_inseam': validates regex pattern ^\d{1,3}x\d{1,3}$ (e.g., '6x28', '32x32').
 */
export function validateSizeAgainstSystem(system: SizeSystem, sizeLabel: string): boolean {
  switch (system) {
    case 'letter':
      return (SIZE_SYSTEMS.letter as readonly string[]).includes(sizeLabel);
    case 'shoe':
      return (SIZE_SYSTEMS.shoe as readonly string[]).includes(sizeLabel);
    case 'numeric_waist_inseam':
      return /^\d{1,3}x\d{1,3}$/.test(sizeLabel);
    default:
      return false;
  }
}
