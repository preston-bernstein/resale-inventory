// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ItemTable, { type ItemRow } from '@/components/ItemTable';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — do it explicitly per file.
afterEach(cleanup);

function bookItem(overrides?: Partial<ItemRow>): ItemRow {
  return {
    id: 'book-1',
    title: 'The Great Gatsby',
    status: 'Listed',
    category: 'book',
    details: {
      isbn: '9780743273565',
      author: 'F. Scott Fitzgerald',
      publisher: 'Scribner',
      condition: 'Very Good',
    },
    acquisition_cost: 500,
    acquisition_date: '2026-01-01',
    listing_price: 1999,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    platforms: ['eBay', 'Poshmark'],
    ...overrides,
  } as ItemRow;
}

function clothingItem(overrides?: Partial<ItemRow>): ItemRow {
  return {
    id: 'clothing-1',
    title: 'Denim Jacket',
    status: 'Unlisted',
    category: 'clothing',
    details: {
      brand: 'Levi\'s',
      size_label: 'M',
      color: 'Blue',
      material: 'Denim',
      gender_department: 'Womens',
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
    },
    acquisition_cost: 800,
    acquisition_date: '2026-01-02',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    platforms: [],
    ...overrides,
  } as ItemRow;
}

describe('ItemTable', () => {
  it('renders book and clothing rows with correct column values', () => {
    const items = [bookItem(), clothingItem()];
    render(<ItemTable items={items} total={2} page={0} limit={20} onPageChange={vi.fn()} />);

    const bookRow = screen.getByText('The Great Gatsby').closest('tr');
    expect(bookRow).not.toBeNull();
    if (!bookRow) throw new Error('bookRow not found');
    expect(within(bookRow).getByText('Book')).toBeInTheDocument();
    expect(within(bookRow).getByText('Very Good')).toBeInTheDocument();
    expect(within(bookRow).getByText('Listed')).toBeInTheDocument();
    expect(within(bookRow).getByText('$19.99')).toBeInTheDocument();
    expect(within(bookRow).getByText('eBay, Poshmark')).toBeInTheDocument();
    expect(within(bookRow).getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      '/inventory/book-1'
    );

    const clothingRow = screen.getByText('Denim Jacket').closest('tr');
    expect(clothingRow).not.toBeNull();
    if (!clothingRow) throw new Error('clothingRow not found');
    expect(within(clothingRow).getByText('Clothing')).toBeInTheDocument();
    expect(within(clothingRow).getByText('EUC')).toBeInTheDocument();
    expect(within(clothingRow).getByText('Unlisted')).toBeInTheDocument();
    // null listing_price AND empty platforms both render an em dash, so two
    // cells in this row show '—'.
    expect(within(clothingRow).getAllByText('—')).toHaveLength(2);
    // confirm there isn't a comma-joined platform string for this row.
    expect(within(clothingRow).queryByText(/,/)).not.toBeInTheDocument();
  });

  it('renders "No items found." for an empty list', () => {
    render(<ItemTable items={[]} total={0} page={0} limit={20} onPageChange={vi.fn()} />);
    expect(screen.getByText('No items found.')).toBeInTheDocument();
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('disables Previous on page 0 and enables Next when more pages remain', () => {
    const items = [bookItem()];
    render(<ItemTable items={items} total={50} page={0} limit={20} onPageChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('disables Next on the last page', () => {
    const items = [bookItem()];
    // total 50, limit 20 -> totalPages = 3 (pages 0,1,2) -> last page index 2
    render(<ItemTable items={items} total={50} page={2} limit={20} onPageChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('calls onPageChange with page - 1 when clicking Previous', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const items = [bookItem()];
    render(<ItemTable items={items} total={50} page={1} limit={20} onPageChange={onPageChange} />);

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('calls onPageChange with page + 1 when clicking Next', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const items = [bookItem()];
    render(<ItemTable items={items} total={50} page={0} limit={20} onPageChange={onPageChange} />);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('shows the correct "Showing X-Y of Z" text for a mid-range page', () => {
    // page 1 (0-indexed, i.e. second page), limit 20, 5 items on this page, total 45
    const items = Array.from({ length: 5 }, (_, i) => bookItem({ id: `book-${i}`, title: `Book ${i}` }));
    render(<ItemTable items={items} total={45} page={1} limit={20} onPageChange={vi.fn()} />);

    // start = 1*20+1 = 21, end = min(1*20+5, 45) = 25
    expect(screen.getByText('Showing 21–25 of 45')).toBeInTheDocument();
  });
});
