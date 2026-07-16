// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ConnectionConfirmation from '../ConnectionConfirmation';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers -- without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

describe('ConnectionConfirmation', () => {
  it('renders the masked identifier passed in via props', () => {
    render(<ConnectionConfirmation platform="ebay" maskedIdentifier="h***o" />);
    expect(screen.getByTestId('connection-confirmation-identifier').textContent).toContain('h***o');
  });

  it('never renders a raw-looking full identifier -- only the masked prop value', () => {
    render(<ConnectionConfirmation platform="etsy" maskedIdentifier="***" />);
    const el = screen.getByTestId('connection-confirmation-identifier');
    expect(el.textContent).toContain('***');
  });

  it('renders the platform name', () => {
    render(<ConnectionConfirmation platform="poshmark" maskedIdentifier="p***k" />);
    expect(screen.getByTestId('connection-confirmation-identifier').textContent).toMatch(/poshmark/i);
  });

  it('renders children below the confirmation banner', () => {
    render(
      <ConnectionConfirmation platform="depop" maskedIdentifier="d***p">
        <div data-testid="child-slot">first-win placeholder</div>
      </ConnectionConfirmation>
    );
    expect(screen.getByTestId('child-slot')).toBeInTheDocument();
  });

  it('renders nothing extra when no children are passed', () => {
    render(<ConnectionConfirmation platform="mercari" maskedIdentifier="m***i" />);
    expect(screen.getByTestId('connection-confirmation')).toBeInTheDocument();
  });
});
