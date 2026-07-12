// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import SiteChrome from '@/components/SiteChrome';

const mockUsePathname = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteChrome', () => {
  it('renders the header/nav for a normal app route', () => {
    mockUsePathname.mockReturnValue('/inventory');
    render(<SiteChrome />);
    expect(screen.getByRole('link', { name: 'Resale Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Playbook' })).toBeInTheDocument();
  });

  it('renders nothing for a /phone/* route', () => {
    mockUsePathname.mockReturnValue('/phone/some-token');
    const { container } = render(<SiteChrome />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
