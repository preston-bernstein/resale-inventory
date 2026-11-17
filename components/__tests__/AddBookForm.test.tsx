// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddBookForm from '@/components/AddBookForm';
import { fieldByLabel, jsonResponse, stubFetch } from './itemForm.fixtures';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(fieldByLabel('Title *'), 'Some Title');
  await user.type(fieldByLabel('Author *'), 'Some Author');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '12.5');
  const dateInput = fieldByLabel('Acquisition Date *');
  await user.type(dateInput, '2026-01-15');
}

async function fillAndSubmit() {
  const user = userEvent.setup();
  render(<AddBookForm />);

  await fillRequiredFields(user);
  await user.click(screen.getByRole('button', { name: 'Add Book' }));
}

const setupAddBookForm = () => {
  stubFetch();
};

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('submits a valid form with the right payload and redirects on success', async () => {
    const fetchMock = stubFetch({ items: jsonResponse(201) });

    await fillAndSubmit();

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('includes trimmed isbn and publisher in the payload when provided', async () => {
    const fetchMock = stubFetch({ items: jsonResponse(201) });

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
    const fetchMock = stubFetch();
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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('surfaces field-level errors from a 422 response without redirecting', async () => {
    stubFetch({ items: jsonResponse(422, { fields: { title: 'Title already exists.' } }) });

    await fillAndSubmit();

    expect(await screen.findByText('Title already exists.')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('surfaces a generic submission error when the server returns a non-201/422 status with an error message', async () => {
    stubFetch({ items: jsonResponse(500, { error: 'Database is on fire.' }) });

    await fillAndSubmit();

    expect(await screen.findByText('Database is on fire.')).toBeInTheDocument();
  });

  it('falls back to a generic "Submission failed." message when the server gives no error body', async () => {
    stubFetch({ items: jsonResponse(500) });

    await fillAndSubmit();

    expect(await screen.findByText('Submission failed.')).toBeInTheDocument();
  });
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('shows a network error message when fetch rejects', async () => {
    stubFetch({ items: new Error('boom') });

    await fillAndSubmit();

    expect(await screen.findByText('Network error — please try again.')).toBeInTheDocument();
  });
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('populates fields on a successful ISBN lookup', async () => {
    stubFetch({ isbn: jsonResponse(200, { title: 'Dune', author: 'Frank Herbert', publisher: 'Ace' }) });

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '9780441013593');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('ISBN found — fields pre-filled.')).toBeInTheDocument();
    expect((fieldByLabel('Title *') as HTMLInputElement).value).toBe('Dune');
    expect((fieldByLabel('Author *') as HTMLInputElement).value).toBe('Frank Herbert');
    expect((fieldByLabel('Publisher') as HTMLInputElement).value).toBe('Ace');
  });
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('rejects a checksum-invalid ISBN-10 client-side without firing the lookup', async () => {
    const fetchMock = stubFetch();

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('rejects a checksum-invalid ISBN-13 client-side without firing the lookup', async () => {
    const fetchMock = stubFetch();

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('rejects a shape-invalid ISBN client-side with the existing format message, distinct from the checksum message', async () => {
    const fetchMock = stubFetch();

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('clears a checksum error once the ISBN is corrected to a checksum-valid value', async () => {
    stubFetch();

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
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('shows a "Not found" message when the ISBN lookup misses', async () => {
    stubFetch();

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '0000000000');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Not found — enter manually.')).toBeInTheDocument();
  });

  it('shows a lookup-failed message when the ISBN fetch throws', async () => {
    stubFetch({ isbn: new Error('network down') });

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '0306406152');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Lookup failed — enter manually.')).toBeInTheDocument();
  });
});

describe('AddBookForm', () => {
  beforeEach(setupAddBookForm);

  it('does nothing when Look up is clicked with a blank ISBN', async () => {
    const fetchMock = stubFetch();
    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/isbn/'))).toBe(false);
  });
});
