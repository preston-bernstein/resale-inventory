// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddItemPage from '@/app/inventory/new/page';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Default fetch mock: only the suggestions endpoint (hit on mount) resolves. */
function stubDefaultFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/items/suggestions')) {
      return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('AddItemPage', () => {
  beforeEach(() => {
    stubDefaultFetch();
  });

  it('defaults to showing the Book form', () => {
    render(<AddItemPage />);
    expect(screen.getByText('Author *')).toBeInTheDocument();
  });

  it('switches to the Clothing form when the Clothing tab is clicked', async () => {
    const user = userEvent.setup();
    render(<AddItemPage />);

    await user.click(screen.getByRole('button', { name: 'Clothing' }));

    expect(screen.getByText('Brand *')).toBeInTheDocument();
    expect(screen.queryByText('Author *')).not.toBeInTheDocument();
  });

  it('switches back to the Book form when the Book tab is clicked again', async () => {
    const user = userEvent.setup();
    render(<AddItemPage />);

    await user.click(screen.getByRole('button', { name: 'Clothing' }));
    expect(screen.getByText('Brand *')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Book' }));
    expect(screen.getByText('Author *')).toBeInTheDocument();
    expect(screen.queryByText('Brand *')).not.toBeInTheDocument();
  });
});
