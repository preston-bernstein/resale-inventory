// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddBookForm from '@/components/AddBookForm';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
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
 */
function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

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

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(fieldByLabel('Title *'), 'Some Title');
  await user.type(fieldByLabel('Author *'), 'Some Author');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '12.5');
  const dateInput = fieldByLabel('Acquisition Date *');
  await user.type(dateInput, '2026-01-15');
}

describe('AddBookForm', () => {
  beforeEach(() => {
    stubDefaultFetch();
  });

  it('renders all fields with Condition defaulting to Good', () => {
    render(<AddBookForm />);

    expect(fieldByLabel('ISBN')).toBeInTheDocument();
    expect(fieldByLabel('Title *')).toBeInTheDocument();
    expect(fieldByLabel('Author *')).toBeInTheDocument();
    expect(fieldByLabel('Publisher')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Cost (USD) *')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Date *')).toBeInTheDocument();

    const condition = fieldByLabel('Condition *') as HTMLSelectElement;
    expect(condition.value).toBe('Good');

    expect(screen.getByRole('button', { name: 'Add Book' })).toBeInTheDocument();
  });

  it('lets the operator type into required text fields', async () => {
    const user = userEvent.setup();
    render(<AddBookForm />);

    const title = fieldByLabel('Title *') as HTMLInputElement;
    const author = fieldByLabel('Author *') as HTMLInputElement;

    await user.type(title, 'Project Hail Mary');
    await user.type(author, 'Andy Weir');

    expect(title.value).toBe('Project Hail Mary');
    expect(author.value).toBe('Andy Weir');
  });

  it('submits a valid form with the right payload and redirects on success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url === '/api/items') {
        return { ok: true, status: 201, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(pushMock).toHaveBeenCalledWith('/inventory');

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const init = postCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      category: 'book',
      title: 'Some Title',
      author: 'Some Author',
      condition: 'Good',
      acquisition_cost: 1250,
      acquisition_date: '2026-01-15',
    });
  });

  it('includes trimmed isbn and publisher in the payload when provided', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url.startsWith('/api/isbn/')) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      if (url === '/api/items') {
        return { ok: true, status: 201, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '9780735224292');
    await user.type(fieldByLabel('Publisher'), '  Some Publisher  ');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.isbn).toBe('9780735224292');
    expect(body.publisher).toBe('Some Publisher');
  });

  it('blocks submission via native required validation when Title is missing', async () => {
    const fetchMock = stubDefaultFetch();
    const user = userEvent.setup();
    render(<AddBookForm />);

    // Fill everything except the required Title field.
    await user.type(fieldByLabel('Author *'), 'Some Author');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '12.5');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');

    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]) === '/api/items')).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces field-level errors from a 422 response without redirecting', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url === '/api/items') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ fields: { title: 'Title already exists.' } }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(await screen.findByText('Title already exists.')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces a generic submission error when the server returns a non-201/422 status with an error message', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url === '/api/items') {
        return { ok: false, status: 500, json: async () => ({ error: 'Database is on fire.' }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(await screen.findByText('Database is on fire.')).toBeInTheDocument();
  });

  it('falls back to a generic "Submission failed." message when the server gives no error body', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url === '/api/items') {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(await screen.findByText('Submission failed.')).toBeInTheDocument();
  });

  it('shows a network error message when fetch rejects', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url === '/api/items') {
        throw new Error('boom');
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expect(await screen.findByText('Network error — please try again.')).toBeInTheDocument();
  });

  it('populates fields on a successful ISBN lookup', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url.startsWith('/api/isbn/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ title: 'Dune', author: 'Frank Herbert', publisher: 'Ace' }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '9780441013593');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('ISBN found — fields pre-filled.')).toBeInTheDocument();
    expect((fieldByLabel('Title *') as HTMLInputElement).value).toBe('Dune');
    expect((fieldByLabel('Author *') as HTMLInputElement).value).toBe('Frank Herbert');
    expect((fieldByLabel('Publisher') as HTMLInputElement).value).toBe('Ace');
  });

  it('rejects a checksum-invalid ISBN-10 client-side without firing the lookup', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    // Real check digit for this prefix is 2, not 6 (see lib/isbn.ts tests).
    await user.type(fieldByLabel('ISBN'), '0306406156');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(
      await screen.findByText("ISBN checksum doesn't match — check the last digit."),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).startsWith('/api/isbn/'))).toBe(
      false,
    );
  });

  it('rejects a checksum-invalid ISBN-13 client-side without firing the lookup', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    // Valid ISBN-13 for this prefix ends in 7, not 8.
    await user.type(fieldByLabel('ISBN'), '9780306406158');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(
      await screen.findByText("ISBN checksum doesn't match — check the last digit."),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).startsWith('/api/isbn/'))).toBe(
      false,
    );
  });

  it('rejects a shape-invalid ISBN client-side with the existing format message, distinct from the checksum message', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '123');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Invalid ISBN format.')).toBeInTheDocument();
    expect(
      screen.queryByText("ISBN checksum doesn't match — check the last digit."),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).startsWith('/api/isbn/'))).toBe(
      false,
    );
  });

  it('clears a checksum error once the ISBN is corrected to a checksum-valid value', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url.startsWith('/api/isbn/')) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    const isbnField = fieldByLabel('ISBN');
    await user.type(isbnField, '0306406156'); // checksum-invalid
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(
      await screen.findByText("ISBN checksum doesn't match — check the last digit."),
    ).toBeInTheDocument();

    await user.clear(isbnField);
    await user.type(isbnField, '0306406152'); // checksum-valid, same prefix
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(
      screen.queryByText("ISBN checksum doesn't match — check the last digit."),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('Not found — enter manually.')).toBeInTheDocument();
  });

  it('shows a "Not found" message when the ISBN lookup misses', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url.startsWith('/api/isbn/')) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '0000000000');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Not found — enter manually.')).toBeInTheDocument();
  });

  it('shows a lookup-failed message when the ISBN fetch throws', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/items/suggestions')) {
        return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
      }
      if (url.startsWith('/api/isbn/')) {
        throw new Error('network down');
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '0306406152');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Lookup failed — enter manually.')).toBeInTheDocument();
  });

  it('does nothing when Look up is clicked with a blank ISBN', async () => {
    const fetchMock = stubDefaultFetch();
    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/isbn/'))).toBe(false);
  });
});
