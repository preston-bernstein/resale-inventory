// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { v4 as uuidv4 } from 'uuid';
import DashboardPage from '@/app/dashboard/page';
import db from '@/lib/db';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

/** Seed a book item directly via SQL (items + book_details). Returns the id. */
function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Seed Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Seed Author',
    publisher: 'Seed Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition)
    VALUES (@id, @isbn, @author, @publisher, @condition)
  `).run(item);
  return id;
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

describe('DashboardPage', () => {
  beforeEach(cleanTables);
  afterEach(cleanTables);

  it('renders the Dashboard heading, a Refresh link, and reflects seeded data', async () => {
    insertBookItem({ title: 'Seeded Novel' });

    // DashboardPage is an async Server Component — Next.js Server Components
    // aren't designed for direct RTL rendering when async, so call it
    // ourselves to get the JSX it returns, then render that.
    const jsx = await DashboardPage();
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    const refreshLink = screen.getByRole('link', { name: 'Refresh' });
    expect(refreshLink).toHaveAttribute('href', '/dashboard');

    // "By Category" section should reflect the seeded book item: the Books
    // card's Count <dd> should read 1. "Books" also appears as a heading in
    // the By Condition section, so scope to the first match (By Category).
    const booksHeading = screen.getAllByText('Books')[0];
    const booksCard = booksHeading.parentElement;
    expect(booksCard).not.toBeNull();
    expect(booksCard).toHaveTextContent('Count');
    expect(booksCard).toHaveTextContent('1');
  });
});
