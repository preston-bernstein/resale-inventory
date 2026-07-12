// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InventoryPage from '@/app/inventory/page';
import type { ItemRow } from '@/components/ItemCardGrid';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function itemRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 'book-1',
    category: 'book',
    title: 'Dune',
    status: 'Unlisted',
    acquisition_cost: 550,
    acquisition_date: '2026-01-15',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2026-01-15T00:00:00.000Z',
    updated_at: '2026-01-15T00:00:00.000Z',
    platforms: [],
    cover_photo_id: null,
    details: { isbn: null, author: 'Frank Herbert', publisher: null, condition: 'Good' },
    ...overrides,
  } as ItemRow;
}

function itemsResponse(items: ItemRow[], total = items.length, page = 0, limit = 25) {
  return { items, total, page, limit };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('InventoryPage', () => {
  it('shows the loading skeleton before the fetch resolves, then the grid once it does', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

    const { container } = render(<InventoryPage />);

    // Skeleton renders placeholder cards with the animate-pulse class and
    // no real item content yet.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Dune')).not.toBeInTheDocument();

    resolveFetch?.(jsonResponse(itemsResponse([itemRow()])));

    await waitFor(() => expect(screen.getByText('Dune')).toBeInTheDocument());
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });

  it('renders the Add Item link and passes fetched items through to the grid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(itemsResponse([itemRow({ title: 'The Hobbit' })]))),
    );

    render(<InventoryPage />);

    expect(screen.getByRole('link', { name: 'Add Item' })).toHaveAttribute('href', '/inventory/new');

    await waitFor(() => expect(screen.getByText('The Hobbit')).toBeInTheDocument());
  });

  it('shows an error message when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 500)));

    render(<InventoryPage />);

    expect(await screen.findByText('HTTP 500')).toBeInTheDocument();
  });

  it('resets page to 0 and re-fetches with updated query params when a filter changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(itemsResponse([itemRow()])))
      .mockResolvedValueOnce(jsonResponse(itemsResponse([itemRow({ title: 'Category Match' })])));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<InventoryPage />);

    await waitFor(() => expect(screen.getByText('Dune')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const categorySelect = screen.getByDisplayValue('All Categories');
    await user.selectOptions(categorySelect, 'book');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCallUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('category=book');
    expect(secondCallUrl).toContain('page=0');

    await waitFor(() => expect(screen.getByText('Category Match')).toBeInTheDocument());
  });

  it('shows the first-run empty state (not the "no matches" state) when no filters are active and no items exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(itemsResponse([], 0))));

    render(<InventoryPage />);

    expect(await screen.findByText(/No items yet/)).toBeInTheDocument();
    expect(screen.queryByText('No items match your filters.')).not.toBeInTheDocument();
  });

  it('clicking Next triggers a new fetch with an incremented page param', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(itemsResponse([itemRow()], 50, 0, 25)))
      .mockResolvedValueOnce(jsonResponse(itemsResponse([itemRow({ id: 'book-2', title: 'Second Page' })], 50, 1, 25)));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<InventoryPage />);

    await waitFor(() => expect(screen.getByText('Dune')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCallUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain('page=1');

    await waitFor(() => expect(screen.getByText('Second Page')).toBeInTheDocument());
  });
});
