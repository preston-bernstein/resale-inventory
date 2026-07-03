import { describe, it, expect } from 'vitest';
import { assertTransitionAllowed, ALLOWED_TRANSITIONS, type BookStatus } from '../transitions';

describe('ALLOWED_TRANSITIONS map', () => {
  it('Unlisted → Listed is allowed', () => {
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow();
  });

  it('Unlisted → Donated is allowed', () => {
    expect(() => assertTransitionAllowed('Unlisted', 'Donated')).not.toThrow();
  });

  it('Unlisted → Discarded is allowed', () => {
    expect(() => assertTransitionAllowed('Unlisted', 'Discarded')).not.toThrow();
  });

  it('Listed → Unlisted is allowed', () => {
    expect(() => assertTransitionAllowed('Listed', 'Unlisted')).not.toThrow();
  });

  it('Listed → Sale Pending is allowed', () => {
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow();
  });

  it('Listed → Removed is allowed', () => {
    expect(() => assertTransitionAllowed('Listed', 'Removed')).not.toThrow();
  });

  it('Sale Pending → Listed is allowed', () => {
    expect(() => assertTransitionAllowed('Sale Pending', 'Listed')).not.toThrow();
  });

  it('Sale Pending → Sold is allowed', () => {
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow();
  });
});

describe('assertTransitionAllowed — rejections', () => {
  it('Listed → Sold is rejected (must go via Sale Pending)', () => {
    expect(() => assertTransitionAllowed('Listed', 'Sold')).toThrow(
      'Transition Listed → Sold is not permitted.',
    );
  });

  it('Sold → Listed is rejected (Sold is terminal)', () => {
    expect(() => assertTransitionAllowed('Sold', 'Listed')).toThrow(
      'Transition Sold → Listed is not permitted.',
    );
  });

  it('Sold → Unlisted is rejected', () => {
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow(
      'Transition Sold → Unlisted is not permitted.',
    );
  });

  it('Sold → Sale Pending is rejected', () => {
    expect(() => assertTransitionAllowed('Sold', 'Sale Pending')).toThrow(
      'Transition Sold → Sale Pending is not permitted.',
    );
  });

  it('Sold → Donated is rejected', () => {
    expect(() => assertTransitionAllowed('Sold', 'Donated')).toThrow();
  });

  it('Sold → Discarded is rejected', () => {
    expect(() => assertTransitionAllowed('Sold', 'Discarded')).toThrow();
  });

  it('Removed is terminal — Removed → Listed is rejected', () => {
    expect(() => assertTransitionAllowed('Removed', 'Listed')).toThrow();
  });

  it('Donated is terminal — Donated → Listed is rejected', () => {
    expect(() => assertTransitionAllowed('Donated', 'Listed')).toThrow();
  });

  it('Discarded is terminal — Discarded → Listed is rejected', () => {
    expect(() => assertTransitionAllowed('Discarded', 'Listed')).toThrow();
  });

  it('Unlisted → Sold is rejected', () => {
    expect(() => assertTransitionAllowed('Unlisted', 'Sold')).toThrow();
  });

  it('error message uses arrow character', () => {
    expect(() => assertTransitionAllowed('Sold', 'Unlisted')).toThrow(
      'Transition Sold → Unlisted is not permitted.',
    );
  });
});

describe('ALLOWED_TRANSITIONS set membership', () => {
  it('Sold set is empty', () => {
    expect(ALLOWED_TRANSITIONS['Sold'].size).toBe(0);
  });

  it('Removed set is empty', () => {
    expect(ALLOWED_TRANSITIONS['Removed'].size).toBe(0);
  });

  it('Sale Pending allows exactly Listed and Sold', () => {
    const allowed = ALLOWED_TRANSITIONS['Sale Pending'];
    expect(allowed.has('Listed')).toBe(true);
    expect(allowed.has('Sold')).toBe(true);
    expect(allowed.size).toBe(2);
  });
});
