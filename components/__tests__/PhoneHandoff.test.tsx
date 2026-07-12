// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhoneHandoff from '@/components/PhoneHandoff';
import type { Photo } from '@/lib/types';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — do it explicitly per file.
afterEach(cleanup);

const ITEM_ID = 'item-123';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhoneHandoff', () => {
  it('renders a "Continue on phone" button in the idle state', () => {
    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Continue on phone' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('on click, POSTs to the phone-session endpoint and renders a QR code + copyable URL on success', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ url: 'https://desktop.tailnet.ts.net/phone/abc123', expires_at: 1234567890 }, true, 201),
    );

    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Continue on phone' }));

    expect(fetch).toHaveBeenCalledWith(`/api/items/${ITEM_ID}/phone-session`, { method: 'POST' });

    const img = await screen.findByRole('img', { name: 'QR code to continue on phone' });
    expect(img).toHaveAttribute('src', expect.stringMatching(/^data:image\//));

    const urlField = screen.getByDisplayValue('https://desktop.tailnet.ts.net/phone/abc123');
    expect(urlField).toHaveAttribute('readOnly');
  });

  it('shows the server-provided error message on a 409 (no tailnet origin)', async () => {
    const user = userEvent.setup();
    const message =
      'Cannot determine a tailnet origin; open this app via its Tailscale Serve URL (…ts.net) to use phone handoff.';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: message }, false, 409),
    );

    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Continue on phone' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    // recovery affordance
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a generic error message on other non-2xx responses (e.g. 404)', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: 'Not found.' }, false, 404),
    );

    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Continue on phone' }));

    expect(await screen.findByText('Not found.')).toBeInTheDocument();
  });

  it('shows a generic error message when the fetch call rejects (network failure)', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Continue on phone' }));

    expect(await screen.findByText('Something went wrong — try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('lets the user retry from the error state', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        jsonResponse({ url: 'https://desktop.tailnet.ts.net/phone/xyz789', expires_at: 1 }, true, 201),
      );

    render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Continue on phone' }));
    await screen.findByText('Something went wrong — try again.');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('img', { name: 'QR code to continue on phone' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe('polling and end-session (Task 9b)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function startSession(user: ReturnType<typeof userEvent.setup>) {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ url: 'https://desktop.tailnet.ts.net/phone/abc123', expires_at: 1234567890 }, true, 201),
      );
      render(<PhoneHandoff itemId={ITEM_ID} onPhotosChange={onPhotosChange} />);
      await user.click(screen.getByRole('button', { name: 'Continue on phone' }));
      await screen.findByRole('img', { name: 'QR code to continue on phone' });
    }

    let onPhotosChange: ReturnType<typeof vi.fn<(photos: Photo[]) => void>>;

    beforeEach(() => {
      onPhotosChange = vi.fn();
    });

    it('polls the phone-session endpoint every 3s once the QR is shown and forwards photos via onPhotosChange', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const user = userEvent.setup({ delay: null });
      const photos = [{ id: 'p1', path: '/x', sort_order: 0 }];
      await startSession(user);

      expect(fetch).toHaveBeenCalledTimes(1); // just the initial POST so far

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'waiting', expires_at: 1234567890, photos }, true, 200),
      );
      await vi.advanceTimersByTimeAsync(3000);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(`/api/items/${ITEM_ID}/phone-session`);
      expect(onPhotosChange).toHaveBeenCalledWith(photos);
    });

    it('updates the status text from waiting to connected as poll responses change', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const user = userEvent.setup({ delay: null });
      await startSession(user);

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'waiting', expires_at: 1234567890, photos: [] }, true, 200),
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByText('Waiting for phone to scan…')).toBeInTheDocument();

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'connected', expires_at: 1234567890, photos: [] }, true, 200),
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByText('Phone connected')).toBeInTheDocument();
      expect(screen.queryByText('Waiting for phone to scan…')).not.toBeInTheDocument();
    });

    it('stops polling and resets to idle once the polled status becomes expired', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const user = userEvent.setup({ delay: null });
      await startSession(user);

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({ status: 'expired', expires_at: 1234567890, photos: [] }, true, 200),
      );
      await vi.advanceTimersByTimeAsync(3000);

      expect(await screen.findByRole('button', { name: 'Continue on phone' })).toBeInTheDocument();

      const callsAfterReset = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(9000);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterReset);
    });

    it('clears the poll interval on unmount', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const user = userEvent.setup({ delay: null });
      await startSession(user);

      const callsAtUnmount = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      cleanup();

      await vi.advanceTimersByTimeAsync(9000);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtUnmount);
    });

    it('End session sends a DELETE request and resets the component to idle', async () => {
      const user = userEvent.setup();
      await startSession(user);

      expect(screen.getByRole('button', { name: 'End session' })).toBeInTheDocument();

      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 204 } as Response);
      await user.click(screen.getByRole('button', { name: 'End session' }));

      expect(fetch).toHaveBeenLastCalledWith(`/api/items/${ITEM_ID}/phone-session`, { method: 'DELETE' });
      expect(await screen.findByRole('button', { name: 'Continue on phone' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'QR code to continue on phone' })).not.toBeInTheDocument();
    });
  });
});
