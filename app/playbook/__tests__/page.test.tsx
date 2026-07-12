// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PlaybookPage from '@/app/playbook/page';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

describe('PlaybookPage', () => {
  it('renders the Seller Playbook heading', () => {
    render(<PlaybookPage />);
    expect(screen.getByRole('heading', { name: 'Seller Playbook' })).toBeInTheDocument();
  });

  it('renders the 17-step workflow as an ordered list with 17 items', () => {
    render(<PlaybookPage />);
    expect(screen.getByRole('heading', { name: 'The 17-step workflow' })).toBeInTheDocument();

    const heading = screen.getByRole('heading', { name: 'The 17-step workflow' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    const items = section?.querySelectorAll('ol > li') ?? [];
    expect(items.length).toBe(17);
  });
});
