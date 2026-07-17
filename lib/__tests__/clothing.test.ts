import { describe, it, expect } from 'vitest';
import {
  validateWeightOz,
  validateMeasurement,
  validateGenderDepartment,
  validateSizeSystem,
  validateSizeAgainstSystem,
  SIZE_SYSTEMS,
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

describe('validateSizeSystem', () => {
  it("'letter' is valid", () => {
    expect(validateSizeSystem('letter')).toBe(true);
  });

  it("'shoe' is valid", () => {
    expect(validateSizeSystem('shoe')).toBe(true);
  });

  it("'numeric_waist_inseam' is valid", () => {
    expect(validateSizeSystem('numeric_waist_inseam')).toBe(true);
  });

  it("'inches' is invalid (not in the closed vocabulary)", () => {
    expect(validateSizeSystem('inches')).toBe(false);
  });

  it("'Letter' is invalid (case-sensitive)", () => {
    expect(validateSizeSystem('Letter')).toBe(false);
  });

  it('empty string is invalid', () => {
    expect(validateSizeSystem('')).toBe(false);
  });

  it('null is invalid', () => {
    expect(validateSizeSystem(null)).toBe(false);
  });

  it('undefined is invalid', () => {
    expect(validateSizeSystem(undefined)).toBe(false);
  });

  it('42 (number) is invalid', () => {
    expect(validateSizeSystem(42)).toBe(false);
  });
});

describe('SIZE_SYSTEMS', () => {
  it('letter has exactly the 6 expected values', () => {
    expect(SIZE_SYSTEMS.letter).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
  });

  it('shoe has exactly 23 half-step entries from 4 to 15', () => {
    expect(SIZE_SYSTEMS.shoe).toHaveLength(23);
    expect(SIZE_SYSTEMS.shoe[0]).toBe('4');
    expect(SIZE_SYSTEMS.shoe[SIZE_SYSTEMS.shoe.length - 1]).toBe('15');
  });

  it('numeric_waist_inseam has no membership list (regex-validated)', () => {
    expect(SIZE_SYSTEMS.numeric_waist_inseam).toHaveLength(0);
  });
});

describe('validateSizeAgainstSystem', () => {
  describe('letter system', () => {
    it("'M' is valid (exact membership)", () => {
      expect(validateSizeAgainstSystem('letter', 'M')).toBe(true);
    });

    it("'XXL' is valid (last entry)", () => {
      expect(validateSizeAgainstSystem('letter', 'XXL')).toBe(true);
    });

    it("'XS' is valid (first entry)", () => {
      expect(validateSizeAgainstSystem('letter', 'XS')).toBe(true);
    });

    it("'m' is invalid (case-sensitive)", () => {
      expect(validateSizeAgainstSystem('letter', 'm')).toBe(false);
    });

    it("'XXXL' is invalid (not in list)", () => {
      expect(validateSizeAgainstSystem('letter', 'XXXL')).toBe(false);
    });

    it('empty string is invalid', () => {
      expect(validateSizeAgainstSystem('letter', '')).toBe(false);
    });
  });

  describe('shoe system', () => {
    it("'8' is valid (whole size)", () => {
      expect(validateSizeAgainstSystem('shoe', '8')).toBe(true);
    });

    it("'8.5' is valid (half size)", () => {
      expect(validateSizeAgainstSystem('shoe', '8.5')).toBe(true);
    });

    it("'4' is valid (first entry)", () => {
      expect(validateSizeAgainstSystem('shoe', '4')).toBe(true);
    });

    it("'15' is valid (last entry)", () => {
      expect(validateSizeAgainstSystem('shoe', '15')).toBe(true);
    });

    it("'3.5' is invalid (below range)", () => {
      expect(validateSizeAgainstSystem('shoe', '3.5')).toBe(false);
    });

    it("'15.5' is invalid (above range)", () => {
      expect(validateSizeAgainstSystem('shoe', '15.5')).toBe(false);
    });

    it("'8.25' is invalid (not a half-step)", () => {
      expect(validateSizeAgainstSystem('shoe', '8.25')).toBe(false);
    });
  });

  describe('numeric_waist_inseam system', () => {
    it("'32x32' is valid (2-digit x 2-digit)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '32x32')).toBe(true);
    });

    it("'6x28' is valid (1-digit x 2-digit)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '6x28')).toBe(true);
    });

    it("'100x100' is valid (3-digit x 3-digit, upper bound)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '100x100')).toBe(true);
    });

    it("'1x1' is valid (single-digit x single-digit, lower bound)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '1x1')).toBe(true);
    });

    it("'1000x32' is invalid (4-digit waist exceeds bound)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '1000x32')).toBe(false);
    });

    it("'32x1000' is invalid (4-digit inseam exceeds bound)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '32x1000')).toBe(false);
    });

    it("'32-32' is invalid (wrong separator)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '32-32')).toBe(false);
    });

    it("'32x' is invalid (missing inseam)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', '32x')).toBe(false);
    });

    it("'x32' is invalid (missing waist)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', 'x32')).toBe(false);
    });

    it("'M' is invalid (letter size under numeric system)", () => {
      expect(validateSizeAgainstSystem('numeric_waist_inseam', 'M')).toBe(false);
    });
  });

  it('an invalid system value falls through to the default false branch', () => {
    expect(
      validateSizeAgainstSystem('invalid_system' as unknown as 'letter', 'M'),
    ).toBe(false);
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
