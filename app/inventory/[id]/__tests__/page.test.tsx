// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ItemDetailPage from '@/app/inventory/[id]/page';
import type { ItemWithRelations, BookDetails, ClothingDetails } from '@/lib/types';

const ITEM_ID = 'test-item-id';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ITEM_ID }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * This app's field labels are bare <label> elements with no for/id
 * association to their input — walk from the label text to the nearest
 * sibling input/select/textarea instead of relying on getByLabelText.
 * (Same convention as components/__tests__/AddBookForm.test.tsx.)
 */
function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

/**
 * The read-only "Details" section renders each field as a
 * <span>Label</span><span>Value</span> pair (see the `Row` component in
 * page.tsx) — no <label> involved at all. Look up the value by its
 * preceding label span instead.
 */
function rowValue(labelText: string): string {
  const label = screen.getByText(labelText, { selector: 'span', exact: true });
  return label.nextElementSibling?.textContent?.trim() ?? '';
}

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

/**
 * A stateful fetch mock that mirrors the real API surface this page talks
 * to: GET /api/items/{id}, PATCH /api/items/{id}, and
 * POST /api/items/{id}/status. PATCH/POST mutate an in-memory record that
 * subsequent GETs (triggered by the component's own refetch-after-success)
 * return, so assertions on post-save UI state reflect the same data flow
 * the real API produces.
 */
function stubItemFetch(initial: ItemWithRelations) {
  const current: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  const base = `/api/items/${initial.id}`;

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url === base) {
      return jsonRes(current);
    }
    if (method === 'PATCH' && url === base) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      if ('listing_price' in body) current.listing_price = body.listing_price;
      if ('platforms' in body) current.platforms = body.platforms;
      if ('condition' in body) {
        current.details = { ...(current.details as Record<string, unknown>), condition: body.condition };
      }
      return jsonRes(current);
    }
    if (method === 'POST' && url === `${base}/status`) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      current.status = body.status;
      if ('sale_price' in body) current.sale_price = body.sale_price;
      if ('sale_platform' in body) current.sale_platform = body.sale_platform;
      if ('sale_date' in body) current.sale_date = body.sale_date;
      return jsonRes(current);
    }
    return jsonRes({}, false, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function makeBookItem(
  overrides: Partial<ItemWithRelations> = {},
  detailsOverrides: Partial<BookDetails> = {},
): ItemWithRelations {
  return {
    id: ITEM_ID,
    category: 'book',
    title: 'The Hobbit',
    status: 'Unlisted',
    acquisition_cost: 500,
    acquisition_date: '2024-01-01',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    details: {
      isbn: null,
      author: 'J.R.R. Tolkien',
      publisher: null,
      condition: 'Good',
      ...detailsOverrides,
    },
    platforms: [],
    price_history: [],
    photos: [],
    ...overrides,
  } as ItemWithRelations;
}

function makeClothingItem(
  overrides: Partial<ItemWithRelations> = {},
  detailsOverrides: Partial<ClothingDetails> = {},
): ItemWithRelations {
  return {
    id: ITEM_ID,
    category: 'clothing',
    title: 'Vintage Jacket',
    status: 'Unlisted',
    acquisition_cost: 1500,
    acquisition_date: '2024-01-01',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    details: {
      brand: 'Patagonia',
      size_label: 'M',
      color: null,
      material: null,
      gender_department: null,
      weight_oz: null,
      pit_to_pit_in: null,
      length_in: null,
      sleeve_length_in: null,
      waist_in: null,
      rise_in: null,
      inseam_in: null,
      leg_opening_in: null,
      hip_in: null,
      condition: 'EUC',
      ...detailsOverrides,
    },
    platforms: [],
    price_history: [],
    photos: [],
    ...overrides,
  } as ItemWithRelations;
}

async function waitForLoad(itemTitle: string) {
  await screen.findByRole('heading', { level: 1, name: itemTitle });
}

describe('ItemDetailPage — loading state', () => {
  it('shows the loading skeleton before the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<ItemDetailPage />);

    const skeleton = container.querySelector('[aria-hidden="true"]');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveClass('animate-pulse');
  });
});

describe('ItemDetailPage — error / not-found state', () => {
  it('renders an error message and a link back to Inventory on a failed fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({}, false, 404)),
    );
    render(<ItemDetailPage />);

    expect(await screen.findByText('HTTP 404')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '← Inventory' });
    expect(link).toHaveAttribute('href', '/inventory');
  });
});

describe('ItemDetailPage — book item', () => {
  it('renders Title/Author/Condition/Status, no Photos section, and no hero photo', async () => {
    const item = makeBookItem();
    stubItemFetch(item);
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    expect(rowValue('Title')).toBe('The Hobbit');
    expect(rowValue('Author')).toBe('J.R.R. Tolkien');
    expect(rowValue('Condition')).toBe('Good');
    expect(rowValue('Status')).toBe('Unlisted');

    expect(screen.queryByRole('heading', { name: 'Photos' })).not.toBeInTheDocument();
    expect(screen.queryByAltText(item.title)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Price History' })).not.toBeInTheDocument();
  });
});

describe('ItemDetailPage — clothing item with a photo', () => {
  it('renders a hero photo and the Photos section', async () => {
    const item = makeClothingItem({
      photos: [{ id: 'photo-1', path: '/data/photos/photo-1.jpg', sort_order: 1 }],
    });
    stubItemFetch(item);
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    const heroImg = screen.getByAltText(item.title);
    expect(heroImg).toHaveAttribute(
      'src',
      expect.stringContaining(encodeURIComponent(`/api/items/${ITEM_ID}/photos/photo-1`)),
    );

    expect(screen.getByRole('heading', { name: 'Photos' })).toBeInTheDocument();
  });
});

describe('ItemDetailPage — Edit Listing form', () => {
  it('submits a PATCH with the price converted to cents, shows "Saved.", and updates the Details row', async () => {
    const item = makeBookItem({ status: 'Unlisted', listing_price: null });
    const fetchMock = stubItemFetch(item);
    const user = userEvent.setup();
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    const priceField = fieldByLabel('Listing Price (USD)');
    await user.type(priceField, '19.99');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]) === `/api/items/${ITEM_ID}` && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const init = patchCall![1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ listing_price: 1999, platforms: [], condition: 'Good' });

    expect(rowValue('Listing Price')).toBe('$19.99');
  });
});

describe('ItemDetailPage — Change Status form', () => {
  it('offers the correct next-status options and submits a plain transition', async () => {
    const item = makeBookItem({ status: 'Unlisted' });
    const fetchMock = stubItemFetch(item);
    const user = userEvent.setup();
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    const select = fieldByLabel('Transition to') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map(o => o.textContent);
    expect(optionLabels).toEqual(['Listed', 'Donated', 'Discarded']);

    await user.selectOptions(select, 'Donated');
    await user.click(screen.getByRole('button', { name: 'Set to Donated' }));

    const postCall = fetchMock.mock.calls.find(
      c => String(c[0]) === `/api/items/${ITEM_ID}/status` && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ status: 'Donated' });
  });

  it('shows Sale Price/Platform/Date once "Sold" is selected and includes them in the request', async () => {
    const item = makeBookItem({ status: 'Sale Pending', listing_price: 1000 });
    const fetchMock = stubItemFetch(item);
    const user = userEvent.setup();
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    const select = fieldByLabel('Transition to') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map(o => o.textContent);
    expect(optionLabels).toEqual(['Listed', 'Sold']);

    expect(screen.queryByText('Sale Price (USD)')).not.toBeInTheDocument();

    await user.selectOptions(select, 'Sold');

    expect(screen.getByText('Sale Price (USD)')).toBeInTheDocument();
    expect(screen.getByText('Sale Platform')).toBeInTheDocument();
    expect(screen.getByText('Sale Date')).toBeInTheDocument();

    await user.type(fieldByLabel('Sale Price (USD)'), '20.00');
    await user.selectOptions(fieldByLabel('Sale Platform') as HTMLSelectElement, 'eBay');
    await user.type(fieldByLabel('Sale Date'), '2026-06-01');

    await user.click(screen.getByRole('button', { name: 'Set to Sold' }));

    const postCall = fetchMock.mock.calls.find(
      c => String(c[0]) === `/api/items/${ITEM_ID}/status` && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'Sold',
      sale_price: 2000,
      sale_platform: 'eBay',
      sale_date: '2026-06-01',
    });
  });
});

describe('ItemDetailPage — terminal item', () => {
  it('does not render the Edit Listing or Change Status sections', async () => {
    const item = makeBookItem({
      status: 'Sold',
      listing_price: 1000,
      sale_price: 1000,
      sale_platform: 'eBay',
      sale_date: '2024-06-01',
    });
    stubItemFetch(item);
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    expect(screen.queryByRole('heading', { name: 'Edit Listing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change Status' })).not.toBeInTheDocument();
  });
});

describe('ItemDetailPage — Price History', () => {
  it('renders a table row per price_history entry', async () => {
    const item = makeBookItem({
      price_history: [
        {
          id: 'ph-1',
          item_id: ITEM_ID,
          previous_price: null,
          new_price: 1000,
          changed_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'ph-2',
          item_id: ITEM_ID,
          previous_price: 1000,
          new_price: 1500,
          changed_at: '2024-02-01T00:00:00.000Z',
        },
      ],
    });
    stubItemFetch(item);
    render(<ItemDetailPage />);

    await waitForLoad(item.title);

    expect(screen.getByRole('heading', { name: 'Price History' })).toBeInTheDocument();

    const table = screen.getByRole('table');
    const dataRows = within(table).getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(2);

    const firstCells = within(dataRows[0]).getAllByRole('cell');
    expect(firstCells[0]).toHaveTextContent('—');
    expect(firstCells[1]).toHaveTextContent('$10.00');
    expect(firstCells[2]).toHaveTextContent(new Date('2024-01-01T00:00:00.000Z').toLocaleString());

    const secondCells = within(dataRows[1]).getAllByRole('cell');
    expect(secondCells[0]).toHaveTextContent('$10.00');
    expect(secondCells[1]).toHaveTextContent('$15.00');
  });
});
