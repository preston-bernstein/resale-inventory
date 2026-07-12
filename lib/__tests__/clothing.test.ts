import { describe, it, expect } from 'vitest';
import {
  validateWeightOz,
  validateMeasurement,
  validateGenderDepartment,
  CLOTHING_MEASUREMENT_FIELDS,
} from '../clothing';
import { BOOK_CONDITIONS, CLOTHING_CONDITIONS, conditionsForCategory } from '../constants';

describe('validateWeightOz', () => {
  it('null is valid (optional field)', () => {
    expect(validateWeightOz(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateWeightOz(undefined)).toBe(true);
  });

  it('0 is valid', () => {
    expect(validateWeightOz(0)).toBe(true);
  });

  it('42 is valid', () => {
    expect(validateWeightOz(42)).toBe(true);
  });

  it('-1 is invalid (negative)', () => {
    expect(validateWeightOz(-1)).toBe(false);
  });

  it('3.5 is invalid (non-integer)', () => {
    expect(validateWeightOz(3.5)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateWeightOz(NaN)).toBe(false);
  });

  it('Infinity is invalid', () => {
    expect(validateWeightOz(Infinity)).toBe(false);
  });

  it("'42' (string) is invalid (wrong type)", () => {
    expect(validateWeightOz('42')).toBe(false);
  });

  it('{} is invalid (wrong type)', () => {
    expect(validateWeightOz({})).toBe(false);
  });

  it('[] is invalid (wrong type)', () => {
    expect(validateWeightOz([])).toBe(false);
  });
});

describe('validateMeasurement', () => {
  it('null is valid', () => {
    expect(validateMeasurement(null)).toBe(true);
  });

  it('undefined is valid', () => {
    expect(validateMeasurement(undefined)).toBe(true);
  });

  it('0 is valid', () => {
    expect(validateMeasurement(0)).toBe(true);
  });

  it('21.5 is valid (fractional values are allowed for measurements)', () => {
    expect(validateMeasurement(21.5)).toBe(true);
  });

  it('-0.1 is invalid (negative)', () => {
    expect(validateMeasurement(-0.1)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateMeasurement(NaN)).toBe(false);
  });

  it("'21.5' (string) is invalid (wrong type)", () => {
    expect(validateMeasurement('21.5')).toBe(false);
  });
});

describe('validateGenderDepartment', () => {
  it('null is valid', () => {
    expect(validateGenderDepartment(null)).toBe(true);
  });

  it('undefined is valid', () => {
    expect(validateGenderDepartment(undefined)).toBe(true);
  });

  it('empty string is valid', () => {
    expect(validateGenderDepartment('')).toBe(true);
  });

  it("\"Women's\" is valid", () => {
    expect(validateGenderDepartment("Women's")).toBe(true);
  });

  it('42 (number) is invalid', () => {
    expect(validateGenderDepartment(42)).toBe(false);
  });

  it('{} is invalid', () => {
    expect(validateGenderDepartment({})).toBe(false);
  });
});

describe('CLOTHING_MEASUREMENT_FIELDS', () => {
  it('has exactly 8 entries', () => {
    expect(CLOTHING_MEASUREMENT_FIELDS).toHaveLength(8);
  });

  it('contains pit_to_pit_in', () => {
    expect(CLOTHING_MEASUREMENT_FIELDS).toContain('pit_to_pit_in');
  });

  it('contains hip_in', () => {
    expect(CLOTHING_MEASUREMENT_FIELDS).toContain('hip_in');
  });
});

describe('conditionsForCategory', () => {
  it("'book' returns BOOK_CONDITIONS", () => {
    expect(conditionsForCategory('book')).toEqual(BOOK_CONDITIONS);
  });

  it("'book' returns the 5 expected values", () => {
    expect(conditionsForCategory('book')).toEqual([
      'Poor',
      'Acceptable',
      'Good',
      'Very Good',
      'Like New',
    ]);
  });

  it("'clothing' returns CLOTHING_CONDITIONS", () => {
    expect(conditionsForCategory('clothing')).toEqual(CLOTHING_CONDITIONS);
  });

  it("'clothing' returns the 5 expected values", () => {
    expect(conditionsForCategory('clothing')).toEqual(['NWT', 'NWOT', 'EUC', 'GUC', 'Fair']);
  });

  it('book and clothing vocabularies share no values in common', () => {
    expect(
      BOOK_CONDITIONS.filter((c) => (CLOTHING_CONDITIONS as readonly string[]).includes(c)),
    ).toHaveLength(0);
  });
});
