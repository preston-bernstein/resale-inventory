// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhonePage from '@/app/phone/[token]/page';

const TOKEN = 'a'.repeat(64);
const ITEM_ID = 'item-123';

vi.mock('next/navigation', () => ({
  useParams: () => ({ token: TOKEN }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('PhonePage — valid token', () => {
  it('renders item title/brand/size and an upload control, no app nav', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({
          item: { id: ITEM_ID, title: 'Denim Jacket', brand: "Levi's", size_label: 'L' },
          expires_at: 123,
        }),
      ),
    );

    render(<PhonePage />);

    expect(await screen.findByText('Denim Jacket')).toBeInTheDocument();
    expect(screen.getByText("Levi's")).toBeInTheDocument();
    expect(screen.getByText('Size L')).toBeInTheDocument();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
    expect(input).toHaveAttribute('multiple');

    expect(fetch).toHaveBeenCalledWith(`/api/phone-session/${TOKEN}`);

    // No links to any other route in the app.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('PhonePage — invalid token', () => {
  it('renders only the error message, no item data, no links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: 'This link is no longer valid.' }, false, 404)),
    );

    render(<PhonePage />);

    expect(await screen.findByText('This link is no longer valid.')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('shows the generic error message when the fetch call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));

    render(<PhonePage />);

    expect(await screen.findByText('This link is no longer valid.')).toBeInTheDocument();
  });
});

describe('PhonePage — upload', () => {
  async function renderReady() {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonRes({
          item: { id: ITEM_ID, title: 'Denim Jacket', brand: "Levi's", size_label: 'L' },
          expires_at: 123,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PhonePage />);
    await screen.findByText('Denim Jacket');
    return fetchMock;
  }

  it('POSTs selected files with the X-Pairing-Token header and shows success feedback', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderReady();
    fetchMock.mockResolvedValueOnce(jsonRes({ photos: [{ id: 'p1', path: 'x', sort_order: 1 }] }, true, 201));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'test.jpg', { type: 'image/jpeg' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe(`/api/items/${ITEM_ID}/photos`);
    expect((options as RequestInit).method).toBe('POST');
    expect((options as RequestInit).headers).toEqual({ 'X-Pairing-Token': TOKEN });
    const formData = (options as RequestInit).body as FormData;
    expect(formData.getAll('files')).toHaveLength(1);
    expect((formData.getAll('files')[0] as File).name).toBe('test.jpg');

    expect(await screen.findByText('1 photo(s) uploaded.')).toBeInTheDocument();
  });

  it('shows the server error message on a JSON failure response (e.g. invalid token)', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderReady();
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'Invalid or expired pairing token.' }, false, 401),
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'test.jpg', { type: 'image/jpeg' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Invalid or expired pairing token.')).toBeInTheDocument();
  });

  it('falls back to a generic message on a non-JSON failure response (e.g. 413 too large)', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderReady();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 413,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'big.jpg', { type: 'image/jpeg' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Upload failed.')).toBeInTheDocument();
  });

  it('shows a validation error and does not call fetch when uploading with no file chosen', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderReady();

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Choose at least one photo.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET
  });
});
