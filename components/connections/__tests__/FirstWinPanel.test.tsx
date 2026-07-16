// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import FirstWinPanel from '@/components/connections/FirstWinPanel';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('FirstWinPanel', () => {
  it('shows the loading skeleton before the fetch resolves', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

    render(<FirstWinPanel connectionId="conn-1" />);

    // Skeleton renders with animate-pulse class and the loading testid.
    const skeleton = screen.getByTestId('first-win-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveClass('animate-pulse');

    // Resolve the fetch to allow subsequent assertions if needed.
    resolveFetch?.(jsonResponse({ healthy: true, readyCount: 0 }));
  });

  it('renders success state with healthy status and readyCount > 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          healthy: true,
          readyCount: 5,
        }),
      ),
    );

    render(<FirstWinPanel connectionId="conn-1" />);

    // Wait for the panel to appear (skeleton disappears).
    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    // Check that the main panel renders.
    expect(screen.getByTestId('first-win-panel')).toBeInTheDocument();

    // Check that the health text shows "Connected and healthy".
    const healthText = screen.getByTestId('first-win-health');
    expect(healthText).toHaveTextContent('Connected and healthy');
    expect(healthText).toHaveClass('text-emerald-700');

    // Check that the ready-count text shows the correct count.
    const countText = screen.getByTestId('first-win-ready-count');
    expect(countText).toHaveTextContent('5 items ready to list');
  });

  it('renders success state with unhealthy status and detail message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          healthy: false,
          detail: 'connector not configured',
          readyCount: 0,
        }),
      ),
    );

    render(<FirstWinPanel connectionId="conn-1" />);

    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    // Check that the health text renders the provided detail message.
    const healthText = screen.getByTestId('first-win-health');
    expect(healthText).toHaveTextContent('connector not configured');
    expect(healthText).toHaveClass('text-red-600');
  });

  it('renders success state with unhealthy status and fallback message when detail is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          healthy: false,
          readyCount: 0,
        }),
      ),
    );

    render(<FirstWinPanel connectionId="conn-1" />);

    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    // Check that the fallback error message appears when detail is not provided.
    const healthText = screen.getByTestId('first-win-health');
    expect(healthText).toHaveTextContent('Connection issue detected');
  });

  it('renders zero-count with informational (not negative-toned) language', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          healthy: true,
          readyCount: 0,
        }),
      ),
    );

    render(<FirstWinPanel connectionId="conn-1" />);

    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    // Check that the ready-count text is informational and not negative-toned.
    const countText = screen.getByTestId('first-win-ready-count');
    expect(countText).toHaveTextContent('No items in your inventory are ready to list yet.');
    // Ensure it does NOT use negative/error styling (gray, not red).
    expect(countText).toHaveClass('text-gray-500');
    // Verify it does not use "failed", "error", or red colors.
    expect(countText).not.toHaveClass('text-red-600');
    expect(countText.textContent).not.toMatch(/failed|error/i);
  });

  it('renders single-item count with correct singular form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          healthy: true,
          readyCount: 1,
        }),
      ),
    );

    render(<FirstWinPanel connectionId="conn-1" />);

    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    const countText = screen.getByTestId('first-win-ready-count');
    expect(countText).toHaveTextContent('1 item ready to list');
  });

  it('renders error state when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));

    render(<FirstWinPanel connectionId="conn-1" />);

    // Wait for the error message to appear.
    const errorElement = await screen.findByTestId('first-win-error');
    expect(errorElement).toBeInTheDocument();
    expect(errorElement).toHaveTextContent("Couldn't check connection status.");
    expect(errorElement).toHaveClass('text-red-600');

    // Ensure the skeleton is gone.
    expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument();
  });

  it('renders error state when fetch returns ok: false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 500)));

    render(<FirstWinPanel connectionId="conn-1" />);

    const errorElement = await screen.findByTestId('first-win-error');
    expect(errorElement).toBeInTheDocument();
    expect(errorElement).toHaveTextContent("Couldn't check connection status.");
  });

  it('respects the connectionId prop when making the fetch request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ healthy: true, readyCount: 3 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FirstWinPanel connectionId="my-special-connection" />);

    await waitFor(() => expect(screen.queryByTestId('first-win-skeleton')).not.toBeInTheDocument());

    // Verify fetch was called with the correct URL including the connectionId.
    expect(fetchMock).toHaveBeenCalledWith('/api/connections/my-special-connection/first-win');
  });
});
