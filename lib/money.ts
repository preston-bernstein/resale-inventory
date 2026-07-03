/**
 * Convert integer cents to a USD string formatted to two decimal places.
 * e.g. 150 → "1.50", 5 → "0.05"
 */
export function centsToUSD(n: number): string {
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const sign = n < 0 ? '-' : '';
  return `${sign}${dollars}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Convert a USD decimal string or number to integer cents.
 * Rounds half-up.
 * Throws if:
 *   - value is non-numeric
 *   - value is negative
 *   - value exceeds 100_000_000 cents (1,000,000 USD)
 */
export function usdToCents(s: string | number): number {
  const str = (typeof s === 'number' ? s.toString() : s).trim();

  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error('Non-numeric value provided.');
  }

  if (str.startsWith('-')) {
    throw new Error('Value must not be negative.');
  }

  // Use string arithmetic to avoid IEEE-754 rounding errors.
  // Split on the decimal point and handle the first 3 fractional digits only.
  const [intPart, fracPart = ''] = str.split('.');

  // Pad/truncate the fraction to exactly 3 digits so we can detect the
  // rounding digit cleanly.
  const frac3 = fracPart.padEnd(3, '0').slice(0, 3);
  const centDigits = parseInt(frac3.slice(0, 2), 10); // first 2 → cents
  const roundDigit = parseInt(frac3[2], 10);          // third → rounding

  let cents = parseInt(intPart, 10) * 100 + centDigits;
  if (roundDigit >= 5) {
    cents += 1;
  }

  if (cents > 100_000_000) {
    throw new Error('Value exceeds maximum allowed (1,000,000 USD).');
  }

  return cents;
}
