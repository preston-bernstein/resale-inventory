// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddBookForm from '@/components/AddBookForm';
import {
  describeSubmissionErrors,
  expectNoItemsPost,
  fieldByLabel,
  fillAndSubmit,
  postedItem,
  stubItemFormFetch,
  type FetchMock,
  type User,
} from './itemFormFixtures';
import { jsonResponse } from '@/tests/jsonResponse';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Types `isbn` into the ISBN field and clicks Look up. */
async function lookUpIsbn(isbn: string) {
  const user = userEvent.setup();
  render(<AddBookForm />);
  await user.type(fieldByLabel('ISBN'), isbn);
  await user.click(screen.getByRole('button', { name: 'Look up' }));
}

function expectNoIsbnLookup(fetchMock: FetchMock) {
  expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).startsWith('/api/isbn/'))).toBe(false);
}

/** Renders the form, fills the required fields and clicks Add Book. */
function submitRequiredFields() {
  return fillAndSubmit(<AddBookForm />, 'Add Book', fillRequiredFields);
}

const CHECKSUM_MESSAGE = "ISBN checksum doesn't match — check the last digit.";

async function fillRequiredFields(user: User) {
  await user.type(fieldByLabel('Title *'), 'Some Title');
  await user.type(fieldByLabel('Author *'), 'Some Author');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '12.5');
  const dateInput = fieldByLabel('Acquisition Date *');
  await user.type(dateInput, '2026-01-15');
}

beforeEach(() => {
  stubItemFormFetch();
});

describe('AddBookForm — fields', () => {
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

describe('AddBookForm — successful submit', () => {
  it('submits a valid form with the right payload and redirects on success', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });

    await submitRequiredFields();

    expect(pushMock).toHaveBeenCalledWith('/inventory');

    const { init, body } = postedItem(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
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

describe('AddBookForm — optional fields and required validation', () => {
  it('includes trimmed isbn and publisher in the payload when provided', async () => {
    const fetchMock = stubItemFormFetch({
      isbn: () => jsonResponse({}, false, 404),
      items: () => jsonResponse({}, true, 201),
    });

    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.type(fieldByLabel('ISBN'), '9780735224292');
    await user.type(fieldByLabel('Publisher'), '  Some Publisher  ');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    const { body } = postedItem(fetchMock);
    expect(body.isbn).toBe('9780735224292');
    expect(body.publisher).toBe('Some Publisher');
  });

  it('blocks submission via native required validation when Title is missing', async () => {
    const fetchMock = stubItemFormFetch();
    const user = userEvent.setup();
    render(<AddBookForm />);

    // Fill everything except the required Title field.
    await user.type(fieldByLabel('Author *'), 'Some Author');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '12.5');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');

    await user.click(screen.getByRole('button', { name: 'Add Book' }));

    expectNoItemsPost(fetchMock);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describeSubmissionErrors({
  name: 'AddBookForm',
  submit: submitRequiredFields,
  pushMock,
  fieldError: { field: 'title', message: 'Title already exists.' },
});

describe('AddBookForm — ISBN lookup', () => {
  it('populates fields on a successful ISBN lookup', async () => {
    stubItemFormFetch({ isbn: () => jsonResponse({ title: 'Dune', author: 'Frank Herbert', publisher: 'Ace' }) });

    await lookUpIsbn('9780441013593');

    expect(await screen.findByText('ISBN found — fields pre-filled.')).toBeInTheDocument();
    expect((fieldByLabel('Title *') as HTMLInputElement).value).toBe('Dune');
    expect((fieldByLabel('Author *') as HTMLInputElement).value).toBe('Frank Herbert');
    expect((fieldByLabel('Publisher') as HTMLInputElement).value).toBe('Ace');
  });

  it('rejects a checksum-invalid ISBN-10 client-side without firing the lookup', async () => {
    const fetchMock = stubItemFormFetch();

    // Real check digit for this prefix is 2, not 6 (see lib/isbn.ts tests).
    await lookUpIsbn('0306406156');

    expect(await screen.findByText(CHECKSUM_MESSAGE)).toBeInTheDocument();
    expectNoIsbnLookup(fetchMock);
  });

  it('rejects a checksum-invalid ISBN-13 client-side without firing the lookup', async () => {
    const fetchMock = stubItemFormFetch();

    // Valid ISBN-13 for this prefix ends in 7, not 8.
    await lookUpIsbn('9780306406158');

    expect(await screen.findByText(CHECKSUM_MESSAGE)).toBeInTheDocument();
    expectNoIsbnLookup(fetchMock);
  });

  it('rejects a shape-invalid ISBN client-side with the existing format message, distinct from the checksum message', async () => {
    const fetchMock = stubItemFormFetch();

    await lookUpIsbn('123');

    expect(await screen.findByText('Invalid ISBN format.')).toBeInTheDocument();
    expect(screen.queryByText(CHECKSUM_MESSAGE)).not.toBeInTheDocument();
    expectNoIsbnLookup(fetchMock);
  });
});

describe('AddBookForm — ISBN correction and failures', () => {
  it('clears a checksum error once the ISBN is corrected to a checksum-valid value', async () => {
    stubItemFormFetch({ isbn: () => jsonResponse({}, false, 404) });

    const user = userEvent.setup();
    render(<AddBookForm />);

    const isbnField = fieldByLabel('ISBN');
    await user.type(isbnField, '0306406156'); // checksum-invalid
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(CHECKSUM_MESSAGE)).toBeInTheDocument();

    await user.clear(isbnField);
    await user.type(isbnField, '0306406152'); // checksum-valid, same prefix
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(screen.queryByText(CHECKSUM_MESSAGE)).not.toBeInTheDocument();
    expect(await screen.findByText('Not found — enter manually.')).toBeInTheDocument();
  });

  it('shows a "Not found" message when the ISBN lookup misses', async () => {
    stubItemFormFetch({ isbn: () => jsonResponse({}, false, 404) });

    await lookUpIsbn('0000000000');

    expect(await screen.findByText('Not found — enter manually.')).toBeInTheDocument();
  });

  it('shows a lookup-failed message when the ISBN fetch throws', async () => {
    stubItemFormFetch({
      isbn: () => {
        throw new Error('network down');
      },
    });

    await lookUpIsbn('0306406152');

    expect(await screen.findByText('Lookup failed — enter manually.')).toBeInTheDocument();
  });

  it('does nothing when Look up is clicked with a blank ISBN', async () => {
    const fetchMock = stubItemFormFetch();
    const user = userEvent.setup();
    render(<AddBookForm />);

    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expectNoIsbnLookup(fetchMock);
  });
});
