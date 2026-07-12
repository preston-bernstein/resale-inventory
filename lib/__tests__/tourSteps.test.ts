import { describe, it, expect } from 'vitest';
import { CLOTHING_TOUR_STEPS, BOOK_TOUR_STEPS } from '../tourSteps';
import { CLOTHING_ANCHORS, BOOK_ANCHORS } from '../tourAnchors';
import { SELLER_WORKFLOW_STEPS } from '../sellerWorkflowSteps';

// FR17/AC11 requires each tour step's copy to be traceable back to a
// specific SELLER_WORKFLOW_STEPS entry. lib/tourSteps.ts tracks this via a
// `// derives from SELLER_WORKFLOW_STEPS[n] ("...")` comment directly above
// each step object. There's no exported index array, so these tests read the
// source file's text and verify the comment's quoted excerpt is a real,
// verbatim substring of the SELLER_WORKFLOW_STEPS entry it cites.
import { readFileSync } from 'fs';
import path from 'path';

const SOURCE = readFileSync(path.resolve(__dirname, '../tourSteps.ts'), 'utf-8');

/**
 * Parses the `// derives from SELLER_WORKFLOW_STEPS[n] ("...")` comments out
 * of tourSteps.ts, in source order, returning the index and quoted excerpt
 * for each. Steps with a "SELLER_WORKFLOW_STEPS[a] / SELLER_WORKFLOW_STEPS[b]"
 * dual-citation only capture the first index/excerpt pair, which is
 * sufficient to prove the derivation mechanism is real and non-arbitrary.
 */
function parseDerivationComments(source: string): Array<{ index: number; excerpt: string }> {
  const regex = /derives from SELLER_WORKFLOW_STEPS\[(\d+)\][^"]*"([^"]+)"/g;
  const matches: Array<{ index: number; excerpt: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    matches.push({ index: Number(match[1]), excerpt: match[2] });
  }
  return matches;
}

describe('CLOTHING_TOUR_STEPS', () => {
  it('has exactly 6 entries', () => {
    expect(CLOTHING_TOUR_STEPS).toHaveLength(6);
  });

  it.each(CLOTHING_TOUR_STEPS.map((step, i) => [i, step] as const))(
    'entry %i has a non-empty target, title, and content',
    (_i, step) => {
      expect(typeof step.target).toBe('string');
      expect((step.target as string).length).toBeGreaterThan(0);
      expect(step.title).toBeTruthy();
      expect(step.content).toBeTruthy();
    },
  );

  it('every target is built from CLOTHING_ANCHORS, not a hardcoded duplicate', () => {
    const expectedTargets = Object.values(CLOTHING_ANCHORS).map((anchor) => `[data-tour="${anchor}"]`);
    const actualTargets = CLOTHING_TOUR_STEPS.map((step) => step.target);
    expect(actualTargets).toEqual(expectedTargets);
  });
});

describe('BOOK_TOUR_STEPS', () => {
  it('has exactly 6 entries', () => {
    expect(BOOK_TOUR_STEPS).toHaveLength(6);
  });

  it.each(BOOK_TOUR_STEPS.map((step, i) => [i, step] as const))(
    'entry %i has a non-empty target, title, and content',
    (_i, step) => {
      expect(typeof step.target).toBe('string');
      expect((step.target as string).length).toBeGreaterThan(0);
      expect(step.title).toBeTruthy();
      expect(step.content).toBeTruthy();
    },
  );

  it('every target is built from BOOK_ANCHORS, not a hardcoded duplicate', () => {
    const expectedTargets = Object.values(BOOK_ANCHORS).map((anchor) => `[data-tour="${anchor}"]`);
    const actualTargets = BOOK_TOUR_STEPS.map((step) => step.target);
    expect(actualTargets).toEqual(expectedTargets);
  });
});

describe('SELLER_WORKFLOW_STEPS derivation (FR17/AC11)', () => {
  const derivations = parseDerivationComments(SOURCE);

  it('finds a derivation comment for every one of the 12 tour steps (6 clothing + 6 book)', () => {
    expect(derivations).toHaveLength(CLOTHING_TOUR_STEPS.length + BOOK_TOUR_STEPS.length);
  });

  it('every cited SELLER_WORKFLOW_STEPS index is in range', () => {
    for (const { index } of derivations) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(SELLER_WORKFLOW_STEPS.length);
    }
  });

  it('every cited excerpt is a verbatim (prefix, for truncated "..." citations) match of the SELLER_WORKFLOW_STEPS entry it points to', () => {
    for (const { index, excerpt } of derivations) {
      // Some dual-citation comments (e.g. "Write the listing..." for steps 8/9
      // combined) truncate the quoted text with a trailing ellipsis rather
      // than quoting the full entry — strip it and check a verbatim prefix
      // match instead of full containment.
      const isTruncated = excerpt.endsWith('...');
      const verbatimExcerpt = isTruncated ? excerpt.slice(0, -3) : excerpt;
      if (isTruncated) {
        expect(SELLER_WORKFLOW_STEPS[index].startsWith(verbatimExcerpt)).toBe(true);
      } else {
        expect(SELLER_WORKFLOW_STEPS[index]).toContain(verbatimExcerpt);
      }
    }
  });
});
