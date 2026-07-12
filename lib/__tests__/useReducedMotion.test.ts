// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../useReducedMotion';

const originalMatchMedia = window.matchMedia;

/**
 * Builds a fake MediaQueryList whose addEventListener/removeEventListener
 * are spies, so tests can assert subscribe-on-mount / unsubscribe-on-unmount
 * without jsdom needing to implement matchMedia's change-event semantics.
 * jsdom (as pinned in this project) doesn't implement window.matchMedia at
 * all, so it's assigned directly here rather than spied on with vi.spyOn
 * (which requires the property to already exist as a function).
 */
function mockMatchMedia(matches: boolean) {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener,
    removeEventListener,
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return { mql, addEventListener, removeEventListener };
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('useReducedMotion', () => {
  it('returns false when matchMedia reports matches: false', () => {
    mockMatchMedia(false);

    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(false);
  });

  it('returns true when matchMedia reports matches: true', () => {
    mockMatchMedia(true);

    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(true);
  });

  it('subscribes via addEventListener("change", ...) on mount', () => {
    const { addEventListener } = mockMatchMedia(false);

    renderHook(() => useReducedMotion());

    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('queries matchMedia with the exact prefers-reduced-motion query string, once for the initial state and once inside the effect', () => {
    mockMatchMedia(false);

    renderHook(() => useReducedMotion());

    expect(window.matchMedia).toHaveBeenCalledTimes(2);
    expect(window.matchMedia).toHaveBeenNthCalledWith(1, '(prefers-reduced-motion: reduce)');
    expect(window.matchMedia).toHaveBeenNthCalledWith(2, '(prefers-reduced-motion: reduce)');
  });

  it('cleans up via removeEventListener on unmount, with the same listener that was added', () => {
    const { addEventListener, removeEventListener } = mockMatchMedia(false);

    const { unmount } = renderHook(() => useReducedMotion());

    expect(removeEventListener).not.toHaveBeenCalled();

    unmount();

    const addedListener = addEventListener.mock.calls[0][1];
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('change', addedListener);
  });

  it('updates the returned value when the registered change handler fires', () => {
    const { addEventListener } = mockMatchMedia(false);

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    const handleChange = addEventListener.mock.calls[0][1] as (event: MediaQueryListEvent) => void;
    act(() => {
      handleChange({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current).toBe(true);
  });
});
