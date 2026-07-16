// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConsentScreen from '@/components/connections/ConsentScreen';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — without this, each test's
// render stays mounted and later queries see duplicate content.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function disclosureResponse(version = 3, content = 'Test disclosure text') {
  return {
    ok: true,
    json: () => Promise.resolve({ version, content }),
  } as Response;
}

describe('ConsentScreen', () => {
  it('fetches disclosure on mount with the correct URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(disclosureResponse());
    vi.stubGlobal('fetch', fetchMock);

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/disclosures/current');
    });
  });

  it('shows loading state briefly, then renders disclosure content and version', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    // Loading state shown
    expect(screen.getByText('Loading disclosure...')).toBeInTheDocument();
    expect(screen.queryByText('Test disclosure text')).not.toBeInTheDocument();

    resolveFetch?.(disclosureResponse(5, 'Test disclosure text'));

    // After fetch resolves, loading state is gone and content is rendered
    await waitFor(() => {
      expect(screen.queryByText('Loading disclosure...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Test disclosure text')).toBeInTheDocument();
    expect(screen.getByText('Disclosure v5')).toBeInTheDocument();
  });

  it('renders risk copy for the platform', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(disclosureResponse()));

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="poshmark" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Automated relisting triggers a.*-day delist\/relist cooldown/),
      ).toBeInTheDocument();
    });
  });

  it('checkbox is unchecked by default and disables Continue button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(disclosureResponse()));

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('Test disclosure text')).toBeInTheDocument();
    });

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    const continueButton = screen.getByRole('button', { name: /I understand, continue/ });
    expect(continueButton).toBeDisabled();
  });

  it('enables Continue button when checkbox is checked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(disclosureResponse()));

    const onAffirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('Test disclosure text')).toBeInTheDocument();
    });

    const checkbox = screen.getByRole('checkbox');
    const continueButton = screen.getByRole('button', { name: /I understand, continue/ });

    expect(continueButton).toBeDisabled();

    await user.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(continueButton).not.toBeDisabled();
  });

  it('clicking Continue with checkbox checked calls onAffirm with version, and fetch is called exactly once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(disclosureResponse(7, 'Test disclosure text'));
    vi.stubGlobal('fetch', fetchMock);

    const onAffirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('Test disclosure text')).toBeInTheDocument();
    });

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    const continueButton = screen.getByRole('button', { name: /I understand, continue/ });
    await user.click(continueButton);

    expect(onAffirm).toHaveBeenCalledWith(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows error message when fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response),
    );

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    });
  });

  it('shows error message when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failed')));

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('Network failed')).toBeInTheDocument();
    });
  });

  it('renders Retry button on error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response),
    );

    const onAffirm = vi.fn();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('clicking Retry re-triggers the fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as Response)
      .mockResolvedValueOnce(disclosureResponse());
    vi.stubGlobal('fetch', fetchMock);

    const onAffirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentScreen platform="ebay" onAffirm={onAffirm} />);

    await waitFor(() => {
      expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    await user.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText('Test disclosure text')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
