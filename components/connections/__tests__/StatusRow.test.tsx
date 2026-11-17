// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StatusRow from '../StatusRow';
import type { ConnectionMetadata } from '@/lib/connections';

// Without test.globals: true in vitest.config.ts, cleanup must be called
// manually after each test to avoid render state leaking between tests.
afterEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: 'conn-1',
    platform: 'ebay',
    status: 'active',
    lastVerifiedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface RowOptions {
  hasValidConsent?: boolean | null;
  operabilityTier?: string;
  onReconnect?: () => void;
  onResumeConsent?: () => void;
  onStatusChange?: () => void;
}

/** Renders a StatusRow with inert defaults; pass only the props a test cares about. */
function renderRow(connection: ConnectionMetadata, options: RowOptions = {}) {
  const props = {
    connection,
    hasValidConsent: true,
    operabilityTier: 'sandbox-tested',
    onReconnect: vi.fn(),
    onResumeConsent: vi.fn(),
    onStatusChange: vi.fn(),
    ...options,
  };
  return render(<StatusRow {...props} />);
}

describe('StatusRow — badge color mapping', () => {
  it('renders green badge for active status', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection);

    const badge = screen.getByTestId('status-badge-conn-1');
    expect(badge).toHaveTextContent('active');
    expect(badge).toHaveClass('bg-emerald-100', 'text-emerald-800');
  });

  it('renders yellow badge for suspended status', () => {
    const connection = createMockConnection({ status: 'suspended' });
    renderRow(connection);

    const badge = screen.getByTestId('status-badge-conn-1');
    expect(badge).toHaveTextContent('suspended');
    expect(badge).toHaveClass('bg-amber-100', 'text-amber-800');
  });

  it('renders red badge for revoked status', () => {
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection);

    const badge = screen.getByTestId('status-badge-conn-1');
    expect(badge).toHaveTextContent('revoked');
    expect(badge).toHaveClass('bg-rose-100', 'text-rose-800');
  });
});

describe('StatusRow — operability tier', () => {
  it('renders blue informational badge regardless of status', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection);

    const tierBadge = screen.getByTestId('operability-tier-conn-1');
    expect(tierBadge).toHaveTextContent('sandbox-tested');
    expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
  });

  it('renders operability tier for suspended status', () => {
    const connection = createMockConnection({ status: 'suspended' });
    renderRow(connection);

    const tierBadge = screen.getByTestId('operability-tier-conn-1');
    expect(tierBadge).toHaveTextContent('sandbox-tested');
    expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
  });

  it('renders operability tier for revoked status', () => {
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection);

    const tierBadge = screen.getByTestId('operability-tier-conn-1');
    expect(tierBadge).toHaveTextContent('sandbox-tested');
    expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
  });
});

describe('StatusRow — stale-consent banner', () => {
  it('does not render when status is active and hasValidConsent is true', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection);

    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
  });

  it('does not render when status is active and hasValidConsent is null', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection, { hasValidConsent: null });

    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
  });

  it('renders when status is active and hasValidConsent is false', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection, { hasValidConsent: false });

    const staleBanner = screen.getByTestId('stale-consent-conn-1');
    expect(staleBanner).toBeInTheDocument();
    expect(staleBanner).toHaveTextContent('Consent needed to resume automation.');
  });

  it('renders as distinct blue informational banner', () => {
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection, { hasValidConsent: false });

    const staleBanner = screen.getByTestId('stale-consent-conn-1');
    expect(staleBanner).toHaveClass('bg-sky-50', 'text-sky-800', 'border-sky-200');
  });
});

describe('StatusRow — stale-consent actions and status gating', () => {
  it('Finish connecting button calls onResumeConsent', async () => {
    const onResumeConsent = vi.fn();
    const connection = createMockConnection({ status: 'active' });
    renderRow(connection, { hasValidConsent: false, onResumeConsent });

    const user = userEvent.setup();
    const finishButton = screen.getByRole('button', { name: 'Finish connecting' });
    await user.click(finishButton);

    expect(onResumeConsent).toHaveBeenCalledTimes(1);
  });

  it('does not render for suspended status even with hasValidConsent false', () => {
    const connection = createMockConnection({ status: 'suspended' });
    renderRow(connection, { hasValidConsent: false });

    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
  });

  it('does not render for revoked status even with hasValidConsent false', () => {
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection, { hasValidConsent: false });

    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
  });
});

function stubReactivateResponse(ok: boolean, status: number) {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: () => Promise.resolve({}),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Renders a suspended row and clicks Reactivate. */
async function clickReactivate(onStatusChange = vi.fn()) {
  renderRow(createMockConnection({ status: 'suspended' }), { onStatusChange });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reactivate' }));
  return onStatusChange;
}

async function expectReactivateError(text: string) {
  await waitFor(() => {
    const errorAlert = screen.getByTestId('reactivate-error-conn-1');
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert).toHaveTextContent(text);
  });
}

describe('StatusRow — reactivate request', () => {
  it('renders Reactivate button when status is suspended', () => {
    renderRow(createMockConnection({ status: 'suspended' }));

    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('calls POST /api/connections/{id}/reactivate when Reactivate is clicked', async () => {
    const fetchMock = stubReactivateResponse(true, 200);

    await clickReactivate();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-1/reactivate', {
        method: 'POST',
      });
    });
  });

  it('calls onStatusChange on successful reactivate', async () => {
    stubReactivateResponse(true, 200);

    const onStatusChange = await clickReactivate();

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledTimes(1);
    });
  });
});

describe('StatusRow — reactivate errors', () => {
  it('surfaces 409 error inline without calling onStatusChange', async () => {
    stubReactivateResponse(false, 409);

    const onStatusChange = await clickReactivate();

    await expectReactivateError('already be active, or revoked');
    expect(screen.getByTestId('reactivate-error-conn-1')).toHaveAttribute('role', 'alert');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('surfaces non-409 HTTP error inline without calling onStatusChange', async () => {
    stubReactivateResponse(false, 500);

    const onStatusChange = await clickReactivate();

    await expectReactivateError('HTTP 500');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('surfaces network error inline without calling onStatusChange', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));

    const onStatusChange = await clickReactivate();

    await expectReactivateError('check your connection');
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});

describe('StatusRow — reactivate button state', () => {
  it('disables Reactivate button while reactivating', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

    renderRow(createMockConnection({ status: 'suspended' }));

    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Reactivate' });
    expect(button).not.toBeDisabled();

    await user.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Reactivating…');

    resolveFetch?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response);

    await waitFor(() => {
      expect(button).not.toBeDisabled();
      expect(button).toHaveTextContent('Reactivate');
    });
  });

  it('does not render Reactivate button for active status', () => {
    renderRow(createMockConnection({ status: 'active' }));

    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
  });

  it('does not render Reactivate button for revoked status', () => {
    renderRow(createMockConnection({ status: 'revoked' }));

    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
  });
});

describe('StatusRow — revoked status', () => {
  it('renders Reconnect button when status is revoked', () => {
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection);

    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('calls onReconnect when Reconnect button is clicked', async () => {
    const onReconnect = vi.fn();
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection, { onReconnect });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('does not render Reactivate button for revoked status', () => {
    const connection = createMockConnection({ status: 'revoked' });
    renderRow(connection);

    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
  });
});

describe('StatusRow — integration scenarios', () => {
  it('renders all expected elements for active status with valid consent', () => {
    const connection = createMockConnection({
      status: 'active',
      platform: 'amazon',
    });
    renderRow(connection, { operabilityTier: 'production-ready' });

    expect(screen.getByText('amazon')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('active');
    expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('production-ready');
    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('renders all expected elements for suspended status', () => {
    const connection = createMockConnection({
      status: 'suspended',
      platform: 'poshmark',
    });
    renderRow(connection, { operabilityTier: 'beta-tested' });

    expect(screen.getByText('poshmark')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('suspended');
    expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('beta-tested');
    expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('renders all expected elements for active status with stale consent', () => {
    const connection = createMockConnection({
      status: 'active',
      platform: 'mercari',
    });
    renderRow(connection, { hasValidConsent: false });

    expect(screen.getByText('mercari')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('active');
    expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('sandbox-tested');
    expect(screen.getByTestId('stale-consent-conn-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
  });
});

describe('StatusRow — Etsy account link', () => {
  function renderEtsyRow(conn: Partial<ConnectionMetadata>) {
    return renderRow(createMockConnection(conn), { operabilityTier: 'live' });
  }

  it('shows a Link Etsy account button on an active Etsy connection only', () => {
    renderEtsyRow({ platform: 'etsy' });
    expect(screen.getByRole('button', { name: 'Link Etsy account' })).toBeInTheDocument();
    cleanup();
    renderEtsyRow({ platform: 'ebay' });
    expect(screen.queryByRole('button', { name: 'Link Etsy account' })).toBeNull();
  });

  it('POSTs to the authorize route and sends the browser to the returned Etsy URL', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ authorizeUrl: 'https://www.etsy.com/oauth/connect?x=1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEtsyRow({ id: 'conn-9', platform: 'etsy' });

    await userEvent.click(screen.getByRole('button', { name: 'Link Etsy account' }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://www.etsy.com/oauth/connect?x=1'),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-9/etsy/authorize', {
      method: 'POST',
    });
  });

  it('tells the user when Etsy is not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'connector_not_configured' }),
      }),
    );
    renderEtsyRow({ id: 'conn-9', platform: 'etsy' });

    await userEvent.click(screen.getByRole('button', { name: 'Link Etsy account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not set up/i);
  });
});

