// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACTIONS, EVENTS, STATUS } from 'react-joyride';
import type { EventData } from 'react-joyride';

import { getNextStepIndex } from '@/lib/tourStateMachine';
import { CLOTHING_TOUR_STEPS } from '@/lib/tourSteps';

// react-joyride's real <Joyride> does DOM measurement + portal rendering that
// jsdom can't meaningfully support — that behavior belongs to the Playwright
// E2E suite (docs/QA.md), not this unit test. Here it's replaced with a stub
// that renders nothing but captures the latest props it was called with, so
// tests can invoke `onEvent` directly the same way the real Joyride would.
// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// regular imports/consts by Vitest.
const { mockJoyrideProps } = vi.hoisted(() => ({
  mockJoyrideProps: { current: null as unknown as Record<string, unknown> },
}));

vi.mock('react-joyride', async () => {
  const actual = await vi.importActual<typeof import('react-joyride')>('react-joyride');
  return {
    ...actual,
    Joyride: (props: Record<string, unknown>) => {
      mockJoyrideProps.current = props;
      return null;
    },
  };
});

// Import the component under test *after* the mock is registered (vi.mock is
// hoisted anyway, but keeping the import below documents the dependency).
import PresaleTour, { isTourCompleted } from '@/components/tour/PresaleTour';

const TOUR_STORAGE_PREFIX = 'presale-tour:v1:';

/**
 * Builds a minimal-but-complete react-joyride EventData payload. PresaleTour's
 * onEvent handler only reads `type`/`index`/`action`/`status`, but the real
 * type has several other required fields — fill them with harmless defaults
 * so callers only need to override what the test actually cares about.
 */
function makeEventData(overrides: Partial<EventData>): EventData {
  return {
    type: EVENTS.STEP_AFTER,
    action: ACTIONS.NEXT,
    controlled: true,
    index: 0,
    lifecycle: 'complete',
    origin: null,
    size: CLOTHING_TOUR_STEPS.length,
    status: STATUS.RUNNING,
    step: {} as EventData['step'],
    error: null,
    scroll: null,
    scrolling: false,
    ...overrides,
  } as EventData;
}

function fireJoyrideEvent(overrides: Partial<EventData>) {
  act(() => {
    (mockJoyrideProps.current.onEvent as (data: EventData) => void)(makeEventData(overrides));
  });
}

beforeAll(() => {
  // jsdom (as pinned in this project) doesn't implement
  // HTMLDialogElement.showModal()/close() — TourCompletionModal (rendered by
  // PresaleTour) calls both. Polyfill the minimum behavior needed for the
  // `open` property + `close` event to behave like the real DOM, scoped to
  // this test file only.
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockJoyrideProps.current = null as unknown as Record<string, unknown>;
  vi.restoreAllMocks();
});

describe('getNextStepIndex (lib/tourStateMachine)', () => {
  it('ACTIONS.NEXT advances the index by one', () => {
    expect(getNextStepIndex(0, ACTIONS.NEXT, 6)).toEqual({ type: 'advance', index: 1 });
    expect(getNextStepIndex(3, ACTIONS.NEXT, 6)).toEqual({ type: 'advance', index: 4 });
  });

  it('ACTIONS.NEXT past the last step closes the tour', () => {
    expect(getNextStepIndex(5, ACTIONS.NEXT, 6)).toEqual({ type: 'close' });
  });

  it('ACTIONS.PREV retreats the index by one', () => {
    expect(getNextStepIndex(3, ACTIONS.PREV, 6)).toEqual({ type: 'advance', index: 2 });
  });

  it('ACTIONS.PREV clamps at 0', () => {
    expect(getNextStepIndex(0, ACTIONS.PREV, 6)).toEqual({ type: 'advance', index: 0 });
  });

  it('any other action defaults to close', () => {
    expect(getNextStepIndex(2, ACTIONS.SKIP, 6)).toEqual({ type: 'close' });
    expect(getNextStepIndex(2, ACTIONS.CLOSE, 6)).toEqual({ type: 'close' });
    expect(getNextStepIndex(2, 'not-a-real-action', 6)).toEqual({ type: 'close' });
  });

  it('totalSteps <= 0 always closes, regardless of action', () => {
    expect(getNextStepIndex(0, ACTIONS.NEXT, 0)).toEqual({ type: 'close' });
    expect(getNextStepIndex(0, ACTIONS.NEXT, -1)).toEqual({ type: 'close' });
  });
});

describe('isTourCompleted', () => {
  it('returns false when localStorage has no entry for the category', () => {
    expect(isTourCompleted('book')).toBe(false);
  });

  it('returns false when the stored value is corrupted/unparseable JSON', () => {
    localStorage.setItem(TOUR_STORAGE_PREFIX + 'book', 'not json{');
    expect(isTourCompleted('book')).toBe(false);
  });

  it('returns false when the stored value is valid JSON but not a completion marker', () => {
    localStorage.setItem(TOUR_STORAGE_PREFIX + 'book', JSON.stringify({ completed: false }));
    expect(isTourCompleted('book')).toBe(false);
  });

  it('returns true once the exact per-category completion key has been seeded', () => {
    localStorage.setItem(TOUR_STORAGE_PREFIX + 'book', JSON.stringify({ completed: true }));
    expect(isTourCompleted('book')).toBe(true);
  });

  it('is scoped per-category — completing "book" does not mark "clothing" complete', () => {
    localStorage.setItem(TOUR_STORAGE_PREFIX + 'book', JSON.stringify({ completed: true }));
    expect(isTourCompleted('clothing')).toBe(false);
  });
});

describe('PresaleTour', () => {
  it('renders the Joyride stub with the category-appropriate steps and starts at step 0', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    expect(mockJoyrideProps.current.steps).toBe(CLOTHING_TOUR_STEPS);
    expect(mockJoyrideProps.current.stepIndex).toBe(0);
    expect(mockJoyrideProps.current.run).toBe(true);
  });

  it('STEP_AFTER with ACTIONS.NEXT advances the controlled stepIndex', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });

    expect(mockJoyrideProps.current.stepIndex).toBe(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('STEP_AFTER with ACTIONS.PREV retreats the controlled stepIndex', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });
    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 1 });
    expect(mockJoyrideProps.current.stepIndex).toBe(2);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.PREV, index: 2 });
    expect(mockJoyrideProps.current.stepIndex).toBe(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('STEP_AFTER with ACTIONS.NEXT past the last step (Finish click) shows the completion modal without immediately closing', () => {
    const onOpenChange = vi.fn();
    const lastIndex = CLOTHING_TOUR_STEPS.length - 1;
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: lastIndex });

    expect(mockJoyrideProps.current.run).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveAttribute('open');
    expect(isTourCompleted('clothing')).toBe(true);
  });

  it('STEP_AFTER with a non-NEXT action resolving to close defensively closes the tour with no modal', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.CLOSE, index: 2 });

    expect(mockJoyrideProps.current.run).toBe(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
  });

  it('TOUR_END/FINISHED shows the completion modal and does NOT immediately call onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.TOUR_END, status: STATUS.FINISHED });

    expect(mockJoyrideProps.current.run).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveAttribute('open');
    expect(isTourCompleted('clothing')).toBe(true);
  });

  it('dismissing the completion modal calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.TOUR_END, status: STATUS.FINISHED });
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // A closed <dialog> (no `open` attribute) drops out of the accessibility
    // tree entirely, so `getByRole('alertdialog')` would fail here even
    // though the element is still mounted — query the raw DOM node instead.
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
  });

  it('TOUR_END/SKIPPED immediately calls onOpenChange(false) with no modal shown', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.TOUR_END, status: STATUS.SKIPPED });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockJoyrideProps.current.run).toBe(false);
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
    expect(isTourCompleted('clothing')).toBe(true);
  });

  it('TARGET_NOT_FOUND immediately calls onOpenChange(false) with no modal shown, and does not mark completion', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.TARGET_NOT_FOUND, index: 2 });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockJoyrideProps.current.run).toBe(false);
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
    expect(isTourCompleted('clothing')).toBe(false);
  });

  it('pressing Escape while open immediately calls onOpenChange(false) with no modal shown', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
    expect(isTourCompleted('clothing')).toBe(true);
  });

  it('Escape does nothing once the tour is already closed (listener is removed)', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    rerender(<PresaleTour category="clothing" open={false} onOpenChange={onOpenChange} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('re-opening the tour restarts at step 0', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });
    expect(mockJoyrideProps.current.stepIndex).toBe(1);

    rerender(<PresaleTour category="clothing" open={false} onOpenChange={onOpenChange} />);
    rerender(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    expect(mockJoyrideProps.current.stepIndex).toBe(0);
    expect(mockJoyrideProps.current.run).toBe(true);
  });

  it('realistic flow: two Next actions then a Skip closes the tour and persists completion', () => {
    const onOpenChange = vi.fn();
    render(<PresaleTour category="clothing" open onOpenChange={onOpenChange} />);

    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });
    fireJoyrideEvent({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 1 });
    expect(mockJoyrideProps.current.stepIndex).toBe(2);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireJoyrideEvent({ type: EVENTS.TOUR_END, status: STATUS.SKIPPED });

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem(TOUR_STORAGE_PREFIX + 'clothing')).toBe(JSON.stringify({ completed: true }));
  });
});
