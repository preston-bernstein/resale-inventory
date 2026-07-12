// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TourCompletionModal from '@/components/tour/TourCompletionModal';

const DEFAULT_MESSAGE = "Tour complete! You're ready to list your first item.";

beforeAll(() => {
  // jsdom (as pinned in this project) doesn't implement
  // HTMLDialogElement.showModal()/close() — TourCompletionModal calls both.
  // Polyfill the minimum behavior needed for the `open` property + `close`
  // event to behave like the real DOM, scoped to this test file only.
  // Mirrors the polyfill in components/tour/__tests__/PresaleTour.test.tsx.
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

afterEach(() => {
  cleanup();
});

describe('TourCompletionModal', () => {
  it('renders the default message when no message prop is given', () => {
    render(<TourCompletionModal open onClose={vi.fn()} />);

    expect(screen.getByText(DEFAULT_MESSAGE)).toBeInTheDocument();
  });

  it('renders a custom message when provided', () => {
    render(<TourCompletionModal open onClose={vi.fn()} message="Custom completion copy." />);

    expect(screen.getByText('Custom completion copy.')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_MESSAGE)).not.toBeInTheDocument();
  });

  it('open=true calls the dialog showModal() and it becomes open', () => {
    render(<TourCompletionModal open onClose={vi.fn()} />);

    const dialog = document.querySelector('dialog');
    expect(dialog).toHaveAttribute('open');
  });

  it('open=false does not open the dialog', () => {
    render(<TourCompletionModal open={false} onClose={vi.fn()} />);

    const dialog = document.querySelector('dialog');
    expect(dialog).not.toHaveAttribute('open');
  });

  it('rerendering from open=true to open=false calls close() on the dialog', () => {
    const { rerender } = render(<TourCompletionModal open onClose={vi.fn()} />);

    const dialog = document.querySelector('dialog');
    expect(dialog).toHaveAttribute('open');

    rerender(<TourCompletionModal open={false} onClose={vi.fn()} />);

    expect(dialog).not.toHaveAttribute('open');
  });

  it('the native close event triggers onClose', () => {
    const onClose = vi.fn();
    render(<TourCompletionModal open onClose={onClose} />);

    const dialog = document.querySelector('dialog');
    expect(dialog).not.toBeNull();

    dialog!.dispatchEvent(new Event('close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the Close button triggers onClose (via the dialog close event)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TourCompletionModal open onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).not.toHaveAttribute('open');
  });

  it('removes the close event listener on unmount (no onClose call after unmount)', () => {
    const onClose = vi.fn();
    const { unmount } = render(<TourCompletionModal open onClose={onClose} />);

    const dialog = document.querySelector('dialog');
    unmount();

    dialog!.dispatchEvent(new Event('close'));

    expect(onClose).not.toHaveBeenCalled();
  });

  describe('fade+scale transition classes', () => {
    it('includes the transition-all/duration-200/ease-out classes on the dialog', () => {
      render(<TourCompletionModal open onClose={vi.fn()} />);

      const dialog = document.querySelector('dialog');
      expect(dialog!.className).toContain('transition-all');
      expect(dialog!.className).toContain('duration-200');
      expect(dialog!.className).toContain('ease-out');
    });

    it('applies opacity-100/scale-100 when open', () => {
      render(<TourCompletionModal open onClose={vi.fn()} />);

      const dialog = document.querySelector('dialog');
      expect(dialog!.className).toContain('opacity-100');
      expect(dialog!.className).toContain('scale-100');
    });

    it('applies opacity-0/scale-95 when closed', () => {
      render(<TourCompletionModal open={false} onClose={vi.fn()} />);

      const dialog = document.querySelector('dialog');
      expect(dialog!.className).toContain('opacity-0');
      expect(dialog!.className).toContain('scale-95');
    });

    it('includes motion-reduce: variant classes suppressing the transition', () => {
      render(<TourCompletionModal open onClose={vi.fn()} />);

      const dialog = document.querySelector('dialog');
      expect(dialog!.className).toContain('motion-reduce:transition-none');
      expect(dialog!.className).toContain('motion-reduce:duration-0');
    });
  });
});
