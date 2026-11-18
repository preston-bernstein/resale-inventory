import { describe, it, expect } from 'vitest';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

let itemId: string;

// ---------------------------------------------------------------------------
// Integration: API (describe.skip — requires running server on :3000)
// ---------------------------------------------------------------------------
describe.skip('API integration (requires running server on localhost:3000) — create and list', () => {
  it('AC2: POST /api/items manual entry (category=book) → 201, status Unlisted, platforms []', async () => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'Manual Entry Book',
        author: 'Jane Smith',
        condition: 'Good',
        acquisition_cost: 1000,
        acquisition_date: '2024-01-01',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    itemId = data.id;
    expect(data.status).toBe('Unlisted');
    expect(data.platforms).toEqual([]);
  });

  it('GET /api/items lists items with pagination envelope', async () => {
    const res = await fetch(`${base}/api/items`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(data.items.length).toBeGreaterThan(0);
  });

  it('AC6: GET /api/items?q=manual is case-insensitive', async () => {
    const res = await fetch(`${base}/api/items?q=MANUAL`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.some((b: { title: string }) => b.title.toLowerCase().includes('manual')),
    ).toBe(true);
  });
});

describe.skip('API integration (requires running server on localhost:3000) — filter, read and price update', () => {
  it('AC7: GET /api/items?condition=Good filters correctly', async () => {
    const res = await fetch(`${base}/api/items?condition=Good`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(
      data.items.every((b: { condition: string }) => b.condition === 'Good'),
    ).toBe(true);
  });

  it('GET /api/items/[id] returns item with platforms and price_history arrays', async () => {
    const res = await fetch(`${base}/api/items/${itemId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.platforms)).toBe(true);
    expect(Array.isArray(data.price_history)).toBe(true);
  });

  it('AC5: PATCH /api/items/[id] two price updates → price_history has entries', async () => {
    await fetch(`${base}/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1500 }),
    });

    const res2 = await fetch(`${base}/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 2000 }),
    });
    expect(res2.status).toBe(200);

    const detail = await (await fetch(`${base}/api/items/${itemId}`)).json();
    expect(detail.price_history.length).toBeGreaterThanOrEqual(1);
    const last = detail.price_history[detail.price_history.length - 1];
    expect(last).toHaveProperty('previous_price');
    expect(last).toHaveProperty('new_price');
    expect(last).toHaveProperty('changed_at');
  });
});

describe.skip('API integration (requires running server on localhost:3000) — status transitions', () => {
  it('status: Unlisted → Listed', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBe(200);
  });

  it('status: Listed → Sale Pending', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Sale Pending' }),
    });
    expect(res.status).toBe(200);
  });

  it('AC3: Sale Pending → Sold; gross_profit = sale_price - acquisition_cost', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Sold',
        sale_price: 2000,
        sale_platform: 'eBay',
        sale_date: '2024-06-01',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('Sold');
    // acquisition_cost=1000, sale_price=2000 → gross_profit=1000
    expect(data.gross_profit).toBe(1000);
  });
});

describe.skip('API integration (requires running server on localhost:3000) — sold guard and export', () => {
  it('AC4: Sold → Listed rejected; item remains Sold', async () => {
    const res = await fetch(`${base}/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const detail = await (await fetch(`${base}/api/items/${itemId}`)).json();
    expect(detail.status).toBe('Sold');
  });

  it('AC10: GET /api/export → CSV with all data model fields', async () => {
    const res = await fetch(`${base}/api/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/i);
    const text = await res.text();
    const header = text.split('\n')[0];
    expect(header).toMatch(/title/i);
    expect(header).toMatch(/author/i);
    expect(header).toMatch(/sale_price/i);
    expect(header).toMatch(/sale_date/i);
    expect(header).toMatch(/acquisition_cost/i);
  });
});

describe.skip('API integration (requires running server on localhost:3000) — import and ISBN outage', () => {
  it('AC9: POST /api/import 50 rows → imported=48, 2 errors with row and fields', async () => {
    const header = 'title,author,condition,acquisition_cost_usd,acquisition_date';
    const valid = Array.from({ length: 48 }, (_, i) =>
      `Import Book ${i + 1},Author ${i + 1},Good,1000,2024-03-01`,
    ).join('\n');
    // Row 49: missing title; Row 50: missing acquisition_cost
    const bad1 = ',No Title Author,Good,1000,2024-03-01';
    const bad2 = 'No Cost Book,No Cost Author,Good,,2024-03-01';
    const csv = [header, valid, bad1, bad2].join('\n');

    const formData = new FormData();
    formData.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');

    const res = await fetch(`${base}/api/import`, { method: 'POST', body: formData });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(48);
    expect(data.errors).toHaveLength(2);
    expect(data.errors[0]).toHaveProperty('row');
    expect(data.errors[0]).toHaveProperty('fields');
  });

  it('AC11: POST /api/items without isbn works (ISBN outage simulation)', async () => {
    const res = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'No ISBN Book',
        author: 'Author Y',
        condition: 'Acceptable',
        acquisition_cost: 500,
        acquisition_date: '2024-02-15',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('Unlisted');
  });
});

describe.skip('API integration (requires running server on localhost:3000) — dashboard', () => {
  it('GET /api/dashboard returns held_count, held_acquisition_cost, by_condition, by_status', async () => {
    const res = await fetch(`${base}/api/dashboard`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('held_count');
    expect(data).toHaveProperty('held_acquisition_cost');
    expect(data).toHaveProperty('by_condition');
    expect(data).toHaveProperty('by_status');
  });
});

describe.skip('API integration (requires running server on localhost:3000) — listed price validation', () => {
  it('D1: POST status Listed without listing_price → 422 (not 500); succeeds after PATCH sets a price', async () => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'D1 Regression Book',
        author: 'Author D1',
        condition: 'Good',
        acquisition_cost: 500,
        acquisition_date: '2024-01-01',
      }),
    });
    const { id } = await created.json();

    const attempt = await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(attempt.status).toBe(422);
    const attemptBody = await attempt.json();
    expect(attemptBody.error).toMatch(/listing_price/);

    await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1200 }),
    });

    const retry = await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.status).toBe('Listed');
  });
});

describe.skip('API integration (requires running server on localhost:3000) — null listing price', () => {
  it('D3: PATCH listing_price null on a Listed item → 422 (not 500)', async () => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'book',
        title: 'D3 Regression Book',
        author: 'Author D3',
        condition: 'Good',
        acquisition_cost: 700,
        acquisition_date: '2024-01-01',
      }),
    });
    const { id } = await created.json();

    await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: 1500 }),
    });
    await fetch(`${base}/api/items/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Listed' }),
    });

    const res = await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing_price: null }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/listing_price/);
  });
});

describe.skip('API integration (requires running server on localhost:3000) — duplicate ISBN import', () => {
  it('D2: POST /api/import with a duplicate ISBN reports a per-row error and still imports the other valid rows (does not lose the whole batch)', async () => {
    const csv = [
      'title,author,condition,acquisition_cost_usd,acquisition_date,isbn',
      'D2 Regression Book A,Auth A,Good,5.00,2024-01-01,9780306406157',
      'D2 Regression Book B,Auth B,Good,6.00,2024-01-02,9780306406157',
      'D2 Regression Book C,Auth C,Good,7.00,2024-01-03,',
    ].join('\n');

    const formData = new FormData();
    formData.append('file', new Blob([csv], { type: 'text/csv' }), 'dup-isbn.csv');

    const res = await fetch(`${base}/api/import`, { method: 'POST', body: formData });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.imported).toBe(2);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].row).toBe(3);
    expect(data.errors[0].fields).toContain('isbn');

    const list = await (await fetch(`${base}/api/items?title=D2 Regression`)).json();
    expect(list.total).toBe(2);
  });
});
