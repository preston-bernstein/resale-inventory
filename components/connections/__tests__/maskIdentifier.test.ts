import { describe, it, expect } from 'vitest';
import { maskIdentifier } from '../maskIdentifier';

describe('maskIdentifier', () => {
  it('masks a typical identifier as first char + fixed middle + last char', () => {
    expect(maskIdentifier('hello')).toBe('h***o');
  });

  it('fully masks a 1-char identifier without exposing the raw value', () => {
    const result = maskIdentifier('h');
    expect(result).toBe('***');
    expect(result).not.toContain('h');
  });

  it('fully masks a 2-char identifier without exposing the raw value', () => {
    const result = maskIdentifier('hy');
    expect(result).toBe('***');
    expect(result).not.toContain('h');
    expect(result).not.toContain('y');
  });

  it('handles an empty identifier without throwing', () => {
    expect(maskIdentifier('')).toBe('***');
  });

  it('never reveals more than the first and last character for longer identifiers', () => {
    const raw = 'supercalifragilisticexpialidocious';
    const result = maskIdentifier(raw);
    expect(result).toBe('s***s');
    // the masked middle must not contain any of the raw inner characters
    expect(result).not.toContain(raw.slice(1, -1));
  });

  it('mask width does not vary with the actual identifier length beyond the two buckets', () => {
    // A 5-char and a 50-char identifier both produce a 5-character mask --
    // the fixed 3-asterisk middle never leaks how long the raw value was.
    const short = maskIdentifier('abcde');
    const long = maskIdentifier('a'.repeat(50));
    expect(short.length).toBe(5);
    expect(long.length).toBe(5);
  });

  it('3-char identifier uses the first/last bucket, not full-mask', () => {
    expect(maskIdentifier('abc')).toBe('a***c');
  });
});
