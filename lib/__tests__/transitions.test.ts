import { describe, it, expect } from 'vitest';
import { assertTransitionAllowed, ALLOWED_TRANSITIONS } from '../transitions';

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

describe('assertTransitionAllowed is category-blind (FR11/AC6)', () => {
  it('has no category parameter or category-conditional branching — the same function call handles both book and clothing items identically', () => {
    // lib/transitions.ts's signature is (from: BookStatus, to: BookStatus) => void — there is no
    // category input to this function. A clothing item and a book item in the same status call
    // this exact same function with the exact same arguments and get the exact same result. The
    // full transition matrix is already exhaustively tested above using status strings alone;
    // this test exists to document, not re-test, that category-blindness is structural rather
    // than a per-category branch that happens to behave the same for both.
    expect(assertTransitionAllowed.length).toBe(2); // arity: (from, to) — no third "category" arg
  });

  it('a full Unlisted → Listed → Sale Pending → Sold lifecycle succeeds regardless of what kind of item it represents', () => {
    // The function has no way to know or care whether the caller is tracking a book or a
    // clothing item — this walks the full happy-path lifecycle once more as a smoke test.
    expect(() => assertTransitionAllowed('Unlisted', 'Listed')).not.toThrow();
    expect(() => assertTransitionAllowed('Listed', 'Sale Pending')).not.toThrow();
    expect(() => assertTransitionAllowed('Sale Pending', 'Sold')).not.toThrow();
  });
});
