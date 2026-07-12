// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TooltipRenderProps } from 'react-joyride';
import TourTooltip from '@/components/tour/TourTooltip';

afterEach(() => {
  cleanup();
});

/**
 * Builds a minimal fake `TooltipRenderProps` object, the shape react-joyride
 * passes to a custom `tooltipComponent`. Only the fields TourTooltip actually
 * reads are populated; the rest are cast away since the component doesn't
 * touch them.
 */
function makeProps(overrides: Partial<TooltipRenderProps> = {}): TooltipRenderProps {
  const backOnClick = vi.fn();
  const primaryOnClick = vi.fn();
  const skipOnClick = vi.fn();

  return {
    backProps: { onClick: backOnClick, 'data-action': 'back', role: 'button' },
    closeProps: { onClick: vi.fn(), 'data-action': 'close', role: 'button' },
    continuous: true,
    index: 1,
    isLastStep: false,
    primaryProps: { onClick: primaryOnClick, 'data-action': 'primary', role: 'button' },
    size: 3,
    skipProps: { onClick: skipOnClick, 'data-action': 'skip', role: 'button' },
    step: {
      target: 'body',
      title: 'Step title',
      content: 'Step content goes here.',
    },
    tooltipProps: { role: 'alertdialog' },
    ...overrides,
  } as unknown as TooltipRenderProps;
}

describe('TourTooltip', () => {
  it('renders the step title and content', () => {
    render(<TourTooltip {...makeProps()} />);

    expect(screen.getByText('Step title')).toBeInTheDocument();
    expect(screen.getByText('Step content goes here.')).toBeInTheDocument();
  });

  it('renders the step position (index + 1 / size)', () => {
    render(<TourTooltip {...makeProps({ index: 1, size: 3 })} />);

    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  describe('Back button visibility', () => {
    it('omits the Back button entirely on the first step (index 0)', () => {
      render(<TourTooltip {...makeProps({ index: 0 })} />);

      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('shows the Back button on any step after the first', () => {
      render(<TourTooltip {...makeProps({ index: 1 })} />);

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    });
  });

  describe('primary button label', () => {
    it('reads "Next" when not the last step', () => {
      render(<TourTooltip {...makeProps({ isLastStep: false })} />);

      expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    });

    it('reads "Finish" when it is the last step', () => {
      render(<TourTooltip {...makeProps({ isLastStep: true })} />);

      expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    });
  });

  describe('button wiring', () => {
    it('invokes backProps.onClick when Back is clicked', async () => {
      const user = userEvent.setup();
      const props = makeProps({ index: 1 });
      render(<TourTooltip {...props} />);

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(props.backProps.onClick).toHaveBeenCalledTimes(1);
    });

    it('invokes primaryProps.onClick when the primary button is clicked', async () => {
      const user = userEvent.setup();
      const props = makeProps({ isLastStep: false });
      render(<TourTooltip {...props} />);

      await user.click(screen.getByRole('button', { name: 'Next' }));

      expect(props.primaryProps.onClick).toHaveBeenCalledTimes(1);
    });

    it('invokes skipProps.onClick when Skip is clicked', async () => {
      const user = userEvent.setup();
      const props = makeProps();
      render(<TourTooltip {...props} />);

      await user.click(screen.getByRole('button', { name: 'Skip' }));

      expect(props.skipProps.onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('focus management', () => {
    it('auto-focuses the primary button on mount', () => {
      render(<TourTooltip {...makeProps({ index: 1 })} />);

      expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    });

    // Tab/Shift+Tab cycling (including wraparound) is intentionally NOT
    // owned by TourTooltip — it's provided by react-joyride's own built-in
    // focus trap (node_modules/react-joyride/src/hooks/useFocusTrap.ts),
    // which only wraps the real <Joyride> render tree, not this isolated
    // component render. A second, component-owned trap used to live here;
    // it was removed because composing it with react-joyride's own trap
    // caused a double-handled Tab press (confirmed against a real browser:
    // tabbing forward from "Back" skipped "Next"/"Finish" entirely and
    // landed on "Skip"). Tab-order coverage now lives in
    // tests/e2e/presale-tour.spec.ts (AC13), which exercises the real
    // <Joyride> composition end-to-end.
  });

  describe('motion/transition classes', () => {
    it('includes fade-in transition classes and reduced-motion overrides', () => {
      render(<TourTooltip {...makeProps()} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('transition-all');
      expect(dialog.className).toContain('duration-200');
      expect(dialog.className).toContain('ease-out');
      expect(dialog.className).toContain('motion-reduce:transition-none');
      expect(dialog.className).toContain('motion-reduce:duration-0');
    });
  });

  describe('Escape key', () => {
    it('does not invoke any button prop-getter when Escape is pressed', async () => {
      const user = userEvent.setup();
      const props = makeProps();
      render(<TourTooltip {...props} />);

      await user.keyboard('{Escape}');

      expect(props.backProps.onClick).not.toHaveBeenCalled();
      expect(props.primaryProps.onClick).not.toHaveBeenCalled();
      expect(props.skipProps.onClick).not.toHaveBeenCalled();
    });
  });
});
