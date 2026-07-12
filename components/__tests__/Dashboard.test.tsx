// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Dashboard from '@/components/Dashboard';
import { BOOK_CONDITIONS, CLOTHING_CONDITIONS } from '@/lib/constants';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup (which detects a global `afterEach`) never
// registers — without this, each test's render stays mounted and later
// queries see duplicate content from every prior test in the file.
afterEach(cleanup);

const STATUS_ORDER = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'];

function buildData(overrides?: Partial<Parameters<typeof Dashboard>[0]['data']>) {
  const by_condition: Record<string, number> = {};
  BOOK_CONDITIONS.forEach((c, i) => { by_condition[c] = i + 1; });
  CLOTHING_CONDITIONS.forEach((c, i) => { by_condition[c] = i + 10; });

  const by_status: Record<string, number> = {};
  STATUS_ORDER.forEach((s, i) => { by_status[s] = i + 1; });

  return {
    held_count: 42,
    held_acquisition_cost: 123456,
    by_condition,
    by_status,
    by_category: {
      book: { count: 20, acquisition_cost: 50000 },
      clothing: { count: 22, acquisition_cost: 73456 },
    },
    ...overrides,
  };
}

describe('Dashboard', () => {
  it('renders summary stat cards with correctly formatted dollar values', () => {
    const data = buildData();
    render(<Dashboard data={data} />);

    expect(screen.getByText('Items Held')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    expect(screen.getByText('Acquisition Cost (Held)')).toBeInTheDocument();
    // 123456 cents -> $1234.56
    expect(screen.getByText('$1234.56')).toBeInTheDocument();
  });

  it('renders by-category counts and formatted acquisition costs for books and clothing', () => {
    const data = buildData();
    render(<Dashboard data={data} />);

    // "Books"/"Clothing" headings also appear in the By Condition section,
    // so assert count (both By Category and By Condition use <h3> headers).
    expect(screen.getAllByText('Books').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Clothing').length).toBeGreaterThanOrEqual(1);

    // book count 20, cost 50000 cents -> $500.00
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();

    // clothing count 22, cost 73456 cents -> $734.56
    expect(screen.getByText('22')).toBeInTheDocument();
    expect(screen.getByText('$734.56')).toBeInTheDocument();
  });

  it('renders every book and clothing condition row with the correct count', () => {
    const data = buildData();
    render(<Dashboard data={data} />);

    BOOK_CONDITIONS.forEach((condition, i) => {
      const label = screen.getByText(condition);
      expect(label).toBeInTheDocument();
      // sibling <dd> holds the count
      expect(label.parentElement).toHaveTextContent(String(i + 1));
    });

    CLOTHING_CONDITIONS.forEach((condition, i) => {
      const label = screen.getByText(condition);
      expect(label).toBeInTheDocument();
      expect(label.parentElement).toHaveTextContent(String(i + 10));
    });
  });

  it('renders every status row with the correct count', () => {
    const data = buildData();
    render(<Dashboard data={data} />);

    STATUS_ORDER.forEach((status, i) => {
      const label = screen.getByText(status);
      expect(label).toBeInTheDocument();
      expect(label.parentElement).toHaveTextContent(String(i + 1));
    });
  });

  it('renders zero values across the board for an all-zero data prop', () => {
    const by_condition: Record<string, number> = {};
    [...BOOK_CONDITIONS, ...CLOTHING_CONDITIONS].forEach((c) => { by_condition[c] = 0; });
    const by_status: Record<string, number> = {};
    STATUS_ORDER.forEach((s) => { by_status[s] = 0; });

    const data = {
      held_count: 0,
      held_acquisition_cost: 0,
      by_condition,
      by_status,
      by_category: {
        book: { count: 0, acquisition_cost: 0 },
        clothing: { count: 0, acquisition_cost: 0 },
      },
    };

    render(<Dashboard data={data} />);

    expect(screen.getByText('Items Held')).toBeInTheDocument();
    // held_count 0 and both category counts 0 all render literal "0"
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThan(0);

    // $0.00 appears for held_acquisition_cost and both category costs
    const zeroDollars = screen.getAllByText('$0.00');
    expect(zeroDollars.length).toBe(3);
  });
});
