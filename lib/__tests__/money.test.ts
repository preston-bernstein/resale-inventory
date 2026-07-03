import { describe, it, expect } from 'vitest';
import { centsToUSD, usdToCents } from '../money';

describe('centsToUSD', () => {
  it('0 → "0.00"', () => {
    expect(centsToUSD(0)).toBe('0.00');
  });

  it('1 → "0.01"', () => {
    expect(centsToUSD(1)).toBe('0.01');
  });

  it('99 → "0.99"', () => {
    expect(centsToUSD(99)).toBe('0.99');
  });

  it('100 → "1.00"', () => {
    expect(centsToUSD(100)).toBe('1.00');
  });

  it('105 → "1.05"', () => {
    expect(centsToUSD(105)).toBe('1.05');
  });

  it('150 → "1.50"', () => {
    expect(centsToUSD(150)).toBe('1.50');
  });

  it('1234567 → "12345.67"', () => {
    expect(centsToUSD(1234567)).toBe('12345.67');
  });

  it('10 → "0.10" (leading zero on cents)', () => {
    expect(centsToUSD(10)).toBe('0.10');
  });

  it('100_000_000 → "1000000.00"', () => {
    expect(centsToUSD(100_000_000)).toBe('1000000.00');
  });
});

describe('usdToCents', () => {
  it('"1.00" → 100', () => {
    expect(usdToCents('1.00')).toBe(100);
  });

  it('"1.50" → 150', () => {
    expect(usdToCents('1.50')).toBe(150);
  });

  it('"0.01" → 1', () => {
    expect(usdToCents('0.01')).toBe(1);
  });

  it('"0.00" → 0', () => {
    expect(usdToCents('0.00')).toBe(0);
  });

  it('numeric 0 → 0', () => {
    expect(usdToCents(0)).toBe(0);
  });

  it('numeric 9.99 → 999', () => {
    expect(usdToCents(9.99)).toBe(999);
  });

  it('"1000000.00" (exactly 1M USD) → 100_000_000', () => {
    expect(usdToCents('1000000.00')).toBe(100_000_000);
  });

  it('rounds half-up: "1.005" → 101', () => {
    expect(usdToCents('1.005')).toBe(101);
  });

  it('rounds half-up: "0.004" → 0', () => {
    expect(usdToCents('0.004')).toBe(0);
  });

  it('throws on negative string', () => {
    expect(() => usdToCents('-1.00')).toThrow();
  });

  it('throws on negative number', () => {
    expect(() => usdToCents(-0.01)).toThrow();
  });

  it('throws when cents exceed 100_000_000', () => {
    expect(() => usdToCents('1000001.00')).toThrow();
  });

  it('throws on non-numeric string', () => {
    expect(() => usdToCents('abc')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => usdToCents('')).toThrow();
  });

  it('throws on string with currency symbol', () => {
    expect(() => usdToCents('$9.99')).toThrow();
  });

  it('whitespace is trimmed — " 1.00 " → 100', () => {
    expect(usdToCents(' 1.00 ')).toBe(100);
  });
});
