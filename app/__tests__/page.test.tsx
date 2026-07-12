// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Home from '@/app/page';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

describe('Home', () => {
  it('renders the Resale Inventory heading', () => {
    render(<Home />);
    expect(screen.getByRole('heading', { name: 'Resale Inventory' })).toBeInTheDocument();
  });

  it('renders a View Inventory link pointing to /inventory', () => {
    render(<Home />);
    const link = screen.getByRole('link', { name: 'View Inventory' });
    expect(link).toHaveAttribute('href', '/inventory');
  });

  it('renders a Dashboard link pointing to /dashboard', () => {
    render(<Home />);
    const link = screen.getByRole('link', { name: 'Dashboard' });
    expect(link).toHaveAttribute('href', '/dashboard');
  });
});
