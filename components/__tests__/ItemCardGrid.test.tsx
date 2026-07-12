// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ItemCardGrid, { ItemCardGridSkeleton, type ItemRow } from '@/components/ItemCardGrid';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

function bookRow(overrides: Partial<ItemRow> = {}): ItemRow {
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

function clothingRow(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 'clothing-1',
    category: 'clothing',
    title: "Levi's 501 Jeans",
    status: 'Listed',
    acquisition_cost: 2500,
    acquisition_date: '2026-01-15',
    listing_price: 3500,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    created_at: '2026-01-15T00:00:00.000Z',
    updated_at: '2026-01-15T00:00:00.000Z',
    platforms: [],
    cover_photo_id: 'photo-1',
    details: {
      brand: "Levi's",
      size_label: '32x30',
      color: 'Indigo',
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
    },
    ...overrides,
  } as ItemRow;
}

describe('ItemCardGrid', () => {
  it('renders a first-run empty state (with an Add Item link) when there are no filters applied', () => {
    render(<ItemCardGrid items={[]} total={0} page={0} limit={20} onPageChange={vi.fn()} />);
    expect(screen.getByText(/No items yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add Item' })).toHaveAttribute('href', '/inventory/new');
  });

  it('renders a "no matches" empty state (no Add Item link) when filters are active', () => {
    render(
      <ItemCardGrid items={[]} total={0} page={0} limit={20} onPageChange={vi.fn()} hasActiveFilters />,
    );
    expect(screen.getByText('No items match your filters.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add Item' })).not.toBeInTheDocument();
  });

  it('renders a card per item with category/status badges, condition, and formatted price', () => {
    render(
      <ItemCardGrid
        items={[bookRow(), clothingRow()]}
        total={2}
        page={0}
        limit={20}
        onPageChange={vi.fn()}
      />,
    );

    const bookCard = screen.getByRole('link', { name: /Dune/ });
    expect(bookCard).toHaveAttribute('href', '/inventory/book-1');
    expect(bookCard).toHaveTextContent('Book');
    expect(bookCard).toHaveTextContent('Unlisted');
    expect(bookCard).toHaveTextContent('Good');
    expect(bookCard).toHaveTextContent('Unpriced'); // listing_price: null

    const clothingCard = screen.getByRole('link', { name: /Levi's 501 Jeans/ });
    expect(clothingCard).toHaveAttribute('href', '/inventory/clothing-1');
    expect(clothingCard).toHaveTextContent('Clothing');
    expect(clothingCard).toHaveTextContent('Listed');
    expect(clothingCard).toHaveTextContent('EUC');
    expect(clothingCard).toHaveTextContent('$35.00');
  });

  it('renders a cover photo image when cover_photo_id is set, and a category placeholder icon when not', () => {
    render(
      <ItemCardGrid
        items={[bookRow(), clothingRow()]}
        total={2}
        page={0}
        limit={20}
        onPageChange={vi.fn()}
      />,
    );

    // <img alt=""> is computed as a decorative/presentation role per
    // HTML-AAM, so it's excluded from getByRole('img'); alt-text queries
    // match on the DOM attribute directly regardless of role, so use those
    // (same pattern already established in PhotoUpload.test.tsx).
    const images = screen.getAllByAltText('');
    expect(images).toHaveLength(1); // only the clothing row has a cover photo
    // next/image rewrites `src` through its optimization proxy with the
    // original URL percent-encoded in a `url=` param, so match a substring
    // of the encoded original path rather than an exact src.
    expect(images[0]).toHaveAttribute(
      'src',
      expect.stringContaining(encodeURIComponent('/api/items/clothing-1/photos/photo-1')),
    );

    // Book row has no cover photo — a placeholder emoji glyph renders
    // instead of an <img>.
    expect(screen.getByText('📖')).toBeInTheDocument();
  });

  it('pagination: Previous disabled on first page, Next disabled on last page, "Showing X-Y of Z" is correct', () => {
    const { rerender } = render(
      <ItemCardGrid
        items={[bookRow()]}
        total={45}
        page={0}
        limit={20}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByText('Showing 1–1 of 45')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();

    rerender(
      <ItemCardGrid
        items={[bookRow()]}
        total={45}
        page={2}
        limit={20}
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
  });

  it('clicking Previous/Next calls onPageChange with the adjacent page number', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <ItemCardGrid
        items={[bookRow()]}
        total={45}
        page={1}
        limit={20}
        onPageChange={onPageChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('renders "No results" text when total is 0 even with a page/limit set', () => {
    render(<ItemCardGrid items={[]} total={0} page={0} limit={20} onPageChange={vi.fn()} />);
    expect(screen.getByText('No results')).toBeInTheDocument();
  });
});

describe('ItemCardGridSkeleton', () => {
  it('renders the requested number of placeholder cards', () => {
    const { container } = render(<ItemCardGridSkeleton count={5} />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(5);
  });

  it('defaults to 8 placeholder cards when count is omitted', () => {
    const { container } = render(<ItemCardGridSkeleton />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(8);
  });
});
