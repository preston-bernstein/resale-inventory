import { describe, it, expect } from 'vitest';
import {
  validateBatteryHealthPct,
  validateBatteryCycleCount,
  validateRamGb,
  validateStorageGb,
  validateScreenSizeIn,
} from '../electronics';

describe('validateBatteryHealthPct', () => {
  it('null is valid (optional field)', () => {
    expect(validateBatteryHealthPct(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateBatteryHealthPct(undefined)).toBe(true);
  });

  it('0 is valid (lower bound)', () => {
    expect(validateBatteryHealthPct(0)).toBe(true);
  });

  it('100 is valid (upper bound)', () => {
    expect(validateBatteryHealthPct(100)).toBe(true);
  });

  it('92 is valid', () => {
    expect(validateBatteryHealthPct(92)).toBe(true);
  });

  it('-1 is invalid (below range)', () => {
    expect(validateBatteryHealthPct(-1)).toBe(false);
  });

  it('101 is invalid (above range)', () => {
    expect(validateBatteryHealthPct(101)).toBe(false);
  });

  it('92.5 is invalid (non-integer)', () => {
    expect(validateBatteryHealthPct(92.5)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateBatteryHealthPct(NaN)).toBe(false);
  });

  it('Infinity is invalid', () => {
    expect(validateBatteryHealthPct(Infinity)).toBe(false);
  });

  it("'92' (string) is invalid (wrong type)", () => {
    expect(validateBatteryHealthPct('92')).toBe(false);
  });

  it('{} is invalid (wrong type)', () => {
    expect(validateBatteryHealthPct({})).toBe(false);
  });
});

describe('validateBatteryCycleCount', () => {
  it('null is valid (optional field)', () => {
    expect(validateBatteryCycleCount(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateBatteryCycleCount(undefined)).toBe(true);
  });

  it('0 is valid', () => {
    expect(validateBatteryCycleCount(0)).toBe(true);
  });

  it('450 is valid', () => {
    expect(validateBatteryCycleCount(450)).toBe(true);
  });

  it('-1 is invalid (negative)', () => {
    expect(validateBatteryCycleCount(-1)).toBe(false);
  });

  it('3.5 is invalid (non-integer)', () => {
    expect(validateBatteryCycleCount(3.5)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateBatteryCycleCount(NaN)).toBe(false);
  });

  it('Infinity is invalid', () => {
    expect(validateBatteryCycleCount(Infinity)).toBe(false);
  });

  it("'450' (string) is invalid (wrong type)", () => {
    expect(validateBatteryCycleCount('450')).toBe(false);
  });

  it('[] is invalid (wrong type)', () => {
    expect(validateBatteryCycleCount([])).toBe(false);
  });
});

describe('validateRamGb', () => {
  it('null is valid (optional field)', () => {
    expect(validateRamGb(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateRamGb(undefined)).toBe(true);
  });

  it('16 is valid', () => {
    expect(validateRamGb(16)).toBe(true);
  });

  it('0.5 is valid (fractional values are allowed)', () => {
    expect(validateRamGb(0.5)).toBe(true);
  });

  it('0 is invalid (must be > 0)', () => {
    expect(validateRamGb(0)).toBe(false);
  });

  it('-1 is invalid (negative)', () => {
    expect(validateRamGb(-1)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateRamGb(NaN)).toBe(false);
  });

  it("'16' (string) is invalid (wrong type)", () => {
    expect(validateRamGb('16')).toBe(false);
  });
});

describe('validateStorageGb', () => {
  it('null is valid (optional field)', () => {
    expect(validateStorageGb(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateStorageGb(undefined)).toBe(true);
  });

  it('512 is valid', () => {
    expect(validateStorageGb(512)).toBe(true);
  });

  it('0 is invalid (must be > 0)', () => {
    expect(validateStorageGb(0)).toBe(false);
  });

  it('-1 is invalid (negative)', () => {
    expect(validateStorageGb(-1)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateStorageGb(NaN)).toBe(false);
  });

  it("'512' (string) is invalid (wrong type)", () => {
    expect(validateStorageGb('512')).toBe(false);
  });
});

describe('validateScreenSizeIn', () => {
  it('null is valid (optional field)', () => {
    expect(validateScreenSizeIn(null)).toBe(true);
  });

  it('undefined is valid (optional field)', () => {
    expect(validateScreenSizeIn(undefined)).toBe(true);
  });

  it('13.3 is valid (fractional values are allowed)', () => {
    expect(validateScreenSizeIn(13.3)).toBe(true);
  });

  it('0 is invalid (must be > 0)', () => {
    expect(validateScreenSizeIn(0)).toBe(false);
  });

  it('-1 is invalid (negative)', () => {
    expect(validateScreenSizeIn(-1)).toBe(false);
  });

  it('NaN is invalid', () => {
    expect(validateScreenSizeIn(NaN)).toBe(false);
  });

  it("'13.3' (string) is invalid (wrong type)", () => {
    expect(validateScreenSizeIn('13.3')).toBe(false);
  });
});
