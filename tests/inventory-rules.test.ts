import { describe, it, expect } from 'vitest';
import { assertTransitionAllowed, ALLOWED_TRANSITIONS } from '../lib/transitions';
import { centsToUSD, usdToCents } from '../lib/money';
import { normalizeISBN } from '../lib/isbn';

// ---------------------------------------------------------------------------
// 1. Unit: lib/transitions.ts
// ---------------------------------------------------------------------------

describe('transitions — valid paths', () => {
  it('Unlisted → Listed', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow());
  it('Unlisted → Donated', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Donated')).not.toThrow());
  it('Unlisted → Discarded', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Discarded')).not.toThrow());
  it('Listed → Unlisted', () =>
    expect(() => assertTransitionAllowed('Listed', 'Unlisted')).not.toThrow());
  it('Listed → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow());
  it('Listed → Removed', () =>
    expect(() => assertTransitionAllowed('Listed', 'Removed')).not.toThrow());
  it('Listed → Donated', () =>
    expect(() => assertTransitionAllowed('Listed', 'Donated')).not.toThrow());
  it('Listed → Discarded', () =>
    expect(() => assertTransitionAllowed('Listed', 'Discarded')).not.toThrow());
  it('Sale Pending → Listed', () =>
    expect(() => assertTransitionAllowed('Sale Pending', 'Listed')).not.toThrow());
  it('Sale Pending → Sold', () =>
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow());
});

describe('transitions — invalid paths (AC4)', () => {
  it('Sold → Listed is rejected (terminal)', () =>
    expect(() => assertTransitionAllowed('Sold', 'Listed')).toThrow(
      'Transition Sold → Listed is not permitted.',
    ));
  it('Sold → Unlisted', () =>
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow());
  it('Sold → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Sold', 'Sale Pending')).toThrow());
  it('Sold → Donated', () =>
    expect(() => assertTransitionAllowed('Sold', 'Donated')).toThrow());
  it('Sold → Discarded', () =>
    expect(() => assertTransitionAllowed('Sold', 'Discarded')).toThrow());
  it('Listed → Sold (must go via Sale Pending)', () =>
    expect(() => assertTransitionAllowed('Listed', 'Sold')).toThrow());
  it('Unlisted → Sold', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Sold')).toThrow());
  it('Unlisted → Sale Pending', () =>
    expect(() => assertTransitionAllowed('Unlisted', 'Sale Pending')).toThrow());
  it('Removed → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Removed', 'Listed')).toThrow());
  it('Donated → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Donated', 'Listed')).toThrow());
  it('Discarded → Listed (terminal)', () =>
    expect(() => assertTransitionAllowed('Discarded', 'Listed')).toThrow());
  it('error message uses arrow character', () =>
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow(
      'Transition Sold → Unlisted is not permitted.',
    ));
});

describe('transitions — ALLOWED_TRANSITIONS set sizes', () => {
  it('Sold is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Sold'].size).toBe(0));
  it('Removed is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Removed'].size).toBe(0));
  it('Donated is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Donated'].size).toBe(0));
  it('Discarded is empty (terminal)', () => expect(ALLOWED_TRANSITIONS['Discarded'].size).toBe(0));
  it('Unlisted has 3 transitions', () => expect(ALLOWED_TRANSITIONS['Unlisted'].size).toBe(3));
  it('Listed has 5 transitions', () => expect(ALLOWED_TRANSITIONS['Listed'].size).toBe(5));
  it('Sale Pending has 2 transitions', () => expect(ALLOWED_TRANSITIONS['Sale Pending'].size).toBe(2));
});

// ---------------------------------------------------------------------------
// 2. Unit: lib/money.ts
// ---------------------------------------------------------------------------

describe('centsToUSD', () => {
  it('0 → "0.00"', () => expect(centsToUSD(0)).toBe('0.00'));
  it('150 → "1.50"', () => expect(centsToUSD(150)).toBe('1.50'));
  it('5 → "0.05"', () => expect(centsToUSD(5)).toBe('0.05'));
  it('999 → "9.99"', () => expect(centsToUSD(999)).toBe('9.99'));
  it('10000 → "100.00"', () => expect(centsToUSD(10000)).toBe('100.00'));
  it('100000000 → "1000000.00" (max)', () => expect(centsToUSD(100000000)).toBe('1000000.00'));
  it('-150 → "-1.50" (negative)', () => expect(centsToUSD(-150)).toBe('-1.50'));
  it('-5 → "-0.05"', () => expect(centsToUSD(-5)).toBe('-0.05'));
});

describe('usdToCents', () => {
  it('"1.50" → 150', () => expect(usdToCents('1.50')).toBe(150));
  it('"0.00" → 0', () => expect(usdToCents('0.00')).toBe(0));
  it('"0.05" → 5', () => expect(usdToCents('0.05')).toBe(5));
  it('"9.99" → 999', () => expect(usdToCents('9.99')).toBe(999));
  it('number 1.5 → 150', () => expect(usdToCents(1.5)).toBe(150));
  it('"1.005" rounds up → 101', () => expect(usdToCents('1.005')).toBe(101));
  it('"1.004" rounds down → 100', () => expect(usdToCents('1.004')).toBe(100));
  it('negative string throws', () => expect(() => usdToCents('-1.00')).toThrow());
  it('negative number throws', () => expect(() => usdToCents(-1)).toThrow());
  it('non-numeric string throws', () => expect(() => usdToCents('abc')).toThrow());
  it('empty string throws', () => expect(() => usdToCents('')).toThrow());
  it('"1000001.00" exceeds max throws', () => expect(() => usdToCents('1000001.00')).toThrow());
  it('number 10000001 exceeds max throws', () => expect(() => usdToCents(10000001)).toThrow());
});

// ---------------------------------------------------------------------------
// 3. Unit: lib/isbn.ts
// ---------------------------------------------------------------------------

describe('normalizeISBN', () => {
  it('ISBN-10 with hyphens → ISBN-13', () =>
    expect(normalizeISBN('0-306-40615-2')).toBe('9780306406157'));
  it('ISBN-10 no hyphens → ISBN-13', () =>
    expect(normalizeISBN('0306406152')).toBe('9780306406157'));
  it('ISBN-13 passthrough', () =>
    expect(normalizeISBN('9780306406157')).toBe('9780306406157'));
  it('ISBN-13 with hyphens → stripped', () =>
    expect(normalizeISBN('978-0-306-40615-7')).toBe('9780306406157'));
  it('invalid ISBN throws', () =>
    expect(() => normalizeISBN('invalid')).toThrow('Invalid ISBN format.'));
  it('too-short string throws', () =>
    expect(() => normalizeISBN('12345')).toThrow());
  it('empty string throws', () =>
    expect(() => normalizeISBN('')).toThrow());
});

describe('lookupISBN', () => {
  it.skip('lookupISBN — network call skipped in unit mode', () => {});
});
