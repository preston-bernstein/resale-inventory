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

describe('StatusRow', () => {
  describe('badge color mapping', () => {
    it('renders green badge for active status', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('active');
      expect(badge).toHaveClass('bg-emerald-100', 'text-emerald-800');
    });

    it('renders yellow badge for suspended status', () => {
      const connection = createMockConnection({ status: 'suspended' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('suspended');
      expect(badge).toHaveClass('bg-amber-100', 'text-amber-800');
    });

    it('renders red badge for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const badge = screen.getByTestId('status-badge-conn-1');
      expect(badge).toHaveTextContent('revoked');
      expect(badge).toHaveClass('bg-rose-100', 'text-rose-800');
    });
  });

  describe('operability tier', () => {
    it('renders blue informational badge regardless of status', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });

    it('renders operability tier for suspended status', () => {
      const connection = createMockConnection({ status: 'suspended' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });

    it('renders operability tier for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const tierBadge = screen.getByTestId('operability-tier-conn-1');
      expect(tierBadge).toHaveTextContent('sandbox-tested');
      expect(tierBadge).toHaveClass('bg-sky-100', 'text-sky-800');
    });
  });

  describe('stale-consent indicator', () => {
    it('does not render when status is active and hasValidConsent is true', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });

    it('does not render when status is active and hasValidConsent is null', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={null}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });

    it('renders when status is active and hasValidConsent is false', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const staleBanner = screen.getByTestId('stale-consent-conn-1');
      expect(staleBanner).toBeInTheDocument();
      expect(staleBanner).toHaveTextContent('Consent needed to resume automation.');
    });

    it('renders as distinct blue informational banner', () => {
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const staleBanner = screen.getByTestId('stale-consent-conn-1');
      expect(staleBanner).toHaveClass('bg-sky-50', 'text-sky-800', 'border-sky-200');
    });

    it('Finish connecting button calls onResumeConsent', async () => {
      const onResumeConsent = vi.fn();
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={onResumeConsent}
          onStatusChange={vi.fn()}
        />,
      );

      const user = userEvent.setup();
      const finishButton = screen.getByRole('button', { name: 'Finish connecting' });
      await user.click(finishButton);

      expect(onResumeConsent).toHaveBeenCalledTimes(1);
    });

    it('does not render for suspended status even with hasValidConsent false', () => {
      const connection = createMockConnection({ status: 'suspended' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });

    it('does not render for revoked status even with hasValidConsent false', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('stale-consent-conn-1')).not.toBeInTheDocument();
    });
  });

  describe('reactivate (suspended status)', () => {
    it('renders Reactivate button when status is suspended', () => {
      const connection = createMockConnection({ status: 'suspended' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    });

    it('calls POST /api/connections/{id}/reactivate when Reactivate is clicked', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      const connection = createMockConnection({ status: 'suspended' });
      const onStatusChange = vi.fn();
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reactivate' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/connections/conn-1/reactivate', {
          method: 'POST',
        });
      });
    });

    it('calls onStatusChange on successful reactivate', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      const connection = createMockConnection({ status: 'suspended' });
      const onStatusChange = vi.fn();
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reactivate' }));

      await waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledTimes(1);
      });
    });

    it('surfaces 409 error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      const connection = createMockConnection({ status: 'suspended' });
      const onStatusChange = vi.fn();
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reactivate' }));

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveAttribute('role', 'alert');
        expect(errorAlert).toHaveTextContent('already be active, or revoked');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('surfaces non-409 HTTP error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', fetchMock);

      const connection = createMockConnection({ status: 'suspended' });
      const onStatusChange = vi.fn();
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reactivate' }));

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveTextContent('HTTP 500');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('surfaces network error inline without calling onStatusChange', async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      vi.stubGlobal('fetch', fetchMock);

      const connection = createMockConnection({ status: 'suspended' });
      const onStatusChange = vi.fn();
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={onStatusChange}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reactivate' }));

      await waitFor(() => {
        const errorAlert = screen.getByTestId('reactivate-error-conn-1');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert).toHaveTextContent('check your connection');
      });

      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('disables Reactivate button while reactivating', async () => {
      let resolveFetch: ((v: Response) => void) | undefined;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

      const connection = createMockConnection({ status: 'suspended' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

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
      const connection = createMockConnection({ status: 'active' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });

    it('does not render Reactivate button for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });

  describe('revoked status', () => {
    it('renders Reconnect button when status is revoked', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    });

    it('calls onReconnect when Reconnect button is clicked', async () => {
      const onReconnect = vi.fn();
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={onReconnect}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Reconnect' }));

      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('does not render Reactivate button for revoked status', () => {
      const connection = createMockConnection({ status: 'revoked' });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });

  describe('integration scenarios', () => {
    it('renders all expected elements for active status with valid consent', () => {
      const connection = createMockConnection({
        status: 'active',
        platform: 'amazon',
      });
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="production-ready"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

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
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={true}
          operabilityTier="beta-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

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
      render(
        <StatusRow
          connection={connection}
          hasValidConsent={false}
          operabilityTier="sandbox-tested"
          onReconnect={vi.fn()}
          onResumeConsent={vi.fn()}
          onStatusChange={vi.fn()}
        />,
      );

      expect(screen.getByText('mercari')).toBeInTheDocument();
      expect(screen.getByTestId('status-badge-conn-1')).toHaveTextContent('active');
      expect(screen.getByTestId('operability-tier-conn-1')).toHaveTextContent('sandbox-tested');
      expect(screen.getByTestId('stale-consent-conn-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
    });
  });
});
