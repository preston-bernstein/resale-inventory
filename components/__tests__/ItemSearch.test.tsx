// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ItemSearch, { type ItemFilters } from '@/components/ItemSearch';
import { BOOK_CONDITIONS, CLOTHING_CONDITIONS } from '@/lib/constants';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — do it explicitly per file.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const EMPTY_FILTERS: ItemFilters = { q: '', category: '', condition: '', status: '' };

// The category/condition/status <select> elements have no accessible
// <label> in this component's JSX, so they're located positionally in DOM
// order: category, condition, status.
function getSelects() {
  return screen.getAllByRole('combobox') as HTMLSelectElement[];
}

describe('ItemSearch', () => {
  it('renders the search input and three filter selects', () => {
    render(<ItemSearch filters={EMPTY_FILTERS} onChange={vi.fn()} />);

    expect(screen.getByPlaceholderText('Search title or author…')).toBeInTheDocument();
    const selects = getSelects();
    expect(selects).toHaveLength(3);
    const [categorySelect, conditionSelect, statusSelect] = selects;

    expect(categorySelect).toHaveValue('');
    expect(statusSelect).toHaveValue('');

    // condition select disabled until a category is chosen
    expect(conditionSelect).toBeDisabled();
    expect(conditionSelect).toHaveValue('');
  });

  it('does not call onChange immediately when typing (debounced), but does after the delay', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ItemSearch filters={EMPTY_FILTERS} onChange={onChange} />);

    const input = screen.getByPlaceholderText('Search title or author…');
    fireEvent.change(input, { target: { value: 'a' } });

    // The keystroke updates the visible input immediately...
    expect(input).toHaveValue('a');
    // ...but onChange (which drives the actual API fetch) hasn't fired yet.
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: 'a' });
  });

  it('resets a pending debounced keystroke if the query changes again before the delay elapses', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ItemSearch filters={EMPTY_FILTERS} onChange={onChange} />);

    const input = screen.getByPlaceholderText('Search title or author…');
    fireEvent.change(input, { target: { value: 'a' } });
    await vi.advanceTimersByTimeAsync(150); // less than the 300ms debounce delay
    fireEvent.change(input, { target: { value: 'ab' } });
    await vi.advanceTimersByTimeAsync(150); // 300ms since 'a', but only 150ms since 'ab'

    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150); // now 300ms since 'ab'

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: 'ab' });
  });

  it('scopes the condition select to the book vocabulary when category=book is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ItemSearch filters={EMPTY_FILTERS} onChange={onChange} />);

    const [categorySelect] = getSelects();
    await user.selectOptions(categorySelect, 'book');

    // clears condition and sets category
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, category: 'book', condition: '' });
  });

  it('renders book condition options and enables the condition select once category=book is set via props', () => {
    const filters: ItemFilters = { ...EMPTY_FILTERS, category: 'book' };
    render(<ItemSearch filters={filters} onChange={vi.fn()} />);

    const [, conditionSelect] = getSelects();
    expect(conditionSelect).toBeEnabled();
    BOOK_CONDITIONS.forEach((condition) => {
      expect(
        screen.getByRole('option', { name: condition })
      ).toBeInTheDocument();
    });
    // clothing-only conditions should not appear
    CLOTHING_CONDITIONS.forEach((condition) => {
      expect(screen.queryByRole('option', { name: condition })).not.toBeInTheDocument();
    });
  });

  it('renders clothing condition options once category=clothing is set via props', () => {
    const filters: ItemFilters = { ...EMPTY_FILTERS, category: 'clothing' };
    render(<ItemSearch filters={filters} onChange={vi.fn()} />);

    const [, conditionSelect] = getSelects();
    expect(conditionSelect).toBeEnabled();
    CLOTHING_CONDITIONS.forEach((condition) => {
      expect(
        screen.getByRole('option', { name: condition })
      ).toBeInTheDocument();
    });
    BOOK_CONDITIONS.forEach((condition) => {
      expect(screen.queryByRole('option', { name: condition })).not.toBeInTheDocument();
    });
  });

  it('calls onChange when selecting a condition (category already chosen)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const filters: ItemFilters = { ...EMPTY_FILTERS, category: 'book' };
    render(<ItemSearch filters={filters} onChange={onChange} />);

    const [, conditionSelect] = getSelects();
    await user.selectOptions(conditionSelect, 'Good');

    expect(onChange).toHaveBeenCalledWith({ ...filters, condition: 'Good' });
  });

  it('calls onChange when selecting a status', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ItemSearch filters={EMPTY_FILTERS} onChange={onChange} />);

    const [, , statusSelect] = getSelects();
    await user.selectOptions(statusSelect, 'Sold');

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, status: 'Sold' });
  });

  it('resets all filters when Clear is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const filters: ItemFilters = { q: 'foo', category: 'book', condition: 'Good', status: 'Sold' };
    render(<ItemSearch filters={filters} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });
});
