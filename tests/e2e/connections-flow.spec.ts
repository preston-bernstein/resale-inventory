import path from 'path';
import Database from 'better-sqlite3';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { uniqueSuffix } from './inventoryPage';

// ---------------------------------------------------------------------------
// SAFETY + WIRING (suspended and revoked flows below): this spec file runs
// in a separate Node process from the webServer that playwright.config.ts
// boots. Those flows put a connection into 'suspended'/'revoked' state
// through lib/connections.ts's recordSuspensionSignal, because no UI or API
// path lets a tenant trigger that transition (it is a backend kill-switch
// signal, normally fired by connector code). So this process must talk to
// the exact scratch SQLite file the webServer uses (playwright.config.ts's
// `e2eDbPath`).
//
// lib/db.ts opens its database at module load from BOOKSELLER_DB_PATH, so
// the env var must be set before lib/connections is first evaluated. Static
// imports are hoisted above any statement in this file, so
// recordSuspension() sets the variable and then loads the module with a
// dynamic import().
// ---------------------------------------------------------------------------

const SCRATCH_DB_PATH = path.resolve(__dirname, '../../.playwright-scratch/inventory.db');

interface ConnectionRow {
  id: string;
  tenant_id: string;
  status: string;
}

function latestConnection(platform: string): ConnectionRow | undefined {
  const db = new Database(SCRATCH_DB_PATH, { fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, tenant_id, status FROM platform_connections
         WHERE platform = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(platform) as ConnectionRow | undefined;
  } finally {
    db.close();
  }
}

function requireLatestConnection(platform: string, description: string): ConnectionRow {
  const row = latestConnection(platform);
  if (!row) throw new Error(`expected the ${description} to exist in the DB`);
  return row;
}

async function recordSuspension(row: ConnectionRow, reason: string, toStatus: 'suspended' | 'revoked') {
  process.env.BOOKSELLER_DB_PATH = SCRATCH_DB_PATH;
  const { recordSuspensionSignal } = await import('@/lib/connections');
  recordSuspensionSignal(row.tenant_id, row.id, reason, toStatus);
}

const FAKE_PASSWORD = 'e2e-fake-password-not-real';

function consentControls(page: Page) {
  return {
    checkbox: page.getByRole('checkbox', { name: 'I understand and accept these risks' }),
    continueButton: page.getByRole('button', { name: 'I understand, continue' }),
  };
}

// Either the empty state (no connections at all yet) or the card grid (some
// connections already exist) renders once the initial fetch resolves -- wait
// for whichever one shows up.
async function revealConnectCard(page: Page, card: Locator) {
  const emptyStateButton = page.getByRole('button', { name: 'Connect a marketplace' });
  await expect(emptyStateButton.or(card)).toBeVisible();

  if (await emptyStateButton.isVisible()) {
    await emptyStateButton.click();
  }

  await expect(card).toBeVisible();
}

async function expectConsentScreenUntouched(page: Page) {
  const { checkbox, continueButton } = consentControls(page);
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(continueButton).toBeDisabled();
}

async function acceptConsent(page: Page) {
  const { checkbox, continueButton } = consentControls(page);
  await checkbox.check();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
}

async function expectCredentialFields(page: Page, label: string) {
  await expect(page.getByLabel(`${label} username`)).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
}

async function submitCredentials(page: Page, label: string, identifier: string, password: string) {
  await page.getByLabel(`${label} username`).fill(identifier);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

async function expectConnectedConfirmation(page: Page, label: string) {
  const confirmation = page.getByTestId('connection-confirmation');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(`${label} connected as @`);
  return confirmation;
}

// Connects a platform end-to-end through the UI, the same steps as the Depop flow.
async function connectViaUi(page: Page, platform: { id: string; label: string }, identifier: string) {
  await page.goto('/connections');

  const card = page.getByTestId(`connect-card-${platform.id}`);
  await revealConnectCard(page, card);
  await card.getByRole('button', { name: 'Connect' }).click();

  await expect(consentControls(page).checkbox).toBeVisible();
  await acceptConsent(page);

  await expectCredentialFields(page, platform.label);
  await submitCredentials(page, platform.label, identifier, FAKE_PASSWORD);
  await expectConnectedConfirmation(page, platform.label);
}

function statusRowFor(page: Page, connectionId: string) {
  return {
    row: page.getByTestId(`status-row-${connectionId}`),
    badge: page.getByTestId(`status-badge-${connectionId}`),
  };
}

async function expectSuspendedRowWithReactivate(page: Page, connectionId: string) {
  await page.goto('/connections');

  const { row, badge } = statusRowFor(page, connectionId);
  await expect(row).toBeVisible();
  await expect(badge).toHaveText('suspended');
  await expect(badge).toHaveClass(/bg-amber-100/);
  await expect(row.getByRole('button', { name: 'Reactivate' })).toBeVisible();
}

async function reactivateAndExpectActive(page: Page, connectionId: string) {
  const { row, badge } = statusRowFor(page, connectionId);
  await row.getByRole('button', { name: 'Reactivate' }).click();

  await expect(badge).toHaveText('active');
  await expect(badge).toHaveClass(/bg-emerald-100/);
  await expect(row.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
}

async function expectRevokedRowWithReconnect(page: Page, connectionId: string) {
  await page.goto('/connections');

  const { row, badge } = statusRowFor(page, connectionId);
  await expect(row).toBeVisible();
  await expect(badge).toHaveText('revoked');
  await expect(badge).toHaveClass(/bg-rose-100/);
  await expect(row.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
}

async function startReconnect(page: Page, connectionId: string) {
  const { row } = statusRowFor(page, connectionId);
  await row.getByRole('button', { name: 'Reconnect' }).click();
  await expectConsentScreenUntouched(page);
}

async function completeReconnect(page: Page, identifier: string) {
  await acceptConsent(page);
  await expectCredentialFields(page, 'Vinted');
  await submitCredentials(page, 'Vinted', `${identifier}-reconnected`, `${FAKE_PASSWORD}-reconnected`);
  await expectConnectedConfirmation(page, 'Vinted');
}

async function expectConsentScreenWithDisclosure(page: Page) {
  await expectConsentScreenUntouched(page);

  // Disclosure content itself is visible (loaded from /api/disclosures/current).
  await expect(page.getByText(/Disclosure v\d+/)).toBeVisible();
}

async function expectMaskedConfirmation(page: Page, identifier: string) {
  const confirmation = await expectConnectedConfirmation(page, 'Depop');
  const confirmationText = await confirmation.textContent();
  expect(confirmationText).not.toContain(identifier);
}

async function expectFirstWinPanelPastSkeleton(page: Page) {
  const panel = page.getByTestId('first-win-panel');
  await expect(page.getByTestId('first-win-skeleton')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('first-win-health')).toBeVisible();
  await expect(page.getByTestId('first-win-ready-count')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Connections flow — happy path (Task 14a).
//
// Drives the full credential-tier connect flow against the real running app
// + scratch DB: connect card -> consent -> credential -> masked confirmation
// -> first-win panel. Uses Depop, a "dry-run-until-credentialed" platform
// (README.md's Marketplace Connectors table) — its connector accepts fake
// credentials and runs in a safe dry-run mode without hitting a real
// marketplace, so this test never needs real env credentials.
//
// This suite runs fullyParallel: false, one worker, sharing one server/DB
// (and, since Task 22, one E2E tenant) across every spec file — tests run
// sequentially. Another spec file (or a prior run within this same file)
// may have already connected other platforms by the time this test runs, so
// this test does NOT assert the page-level empty state (ConnectionsView only
// renders EmptyState when `connections.length === 0 && !cardsExpanded` --
// any pre-existing connection skips straight to the card grid). Instead it
// waits for either the empty-state CTA or the Depop card itself, clicking
// the CTA only if the empty state is what rendered, then drives everything
// else off the Depop-specific testids, which stay stable regardless of what
// else is connected.
// ---------------------------------------------------------------------------
test.describe('Connections flow — happy path', () => {
  test('connect Depop end-to-end: consent -> credential -> masked confirmation -> first-win panel', async ({ page }) => {
    const identifier = `e2e-depop-${uniqueSuffix()}`;
    const depopCard = page.getByTestId('connect-card-depop');

    await page.goto('/connections');

    await test.step('reach the Depop connect card regardless of prior connection state', () =>
      revealConnectCard(page, depopCard));

    await test.step('click Depop\'s Connect button to enter the consent screen', async () => {
      await depopCard.getByRole('button', { name: 'Connect' }).click();
    });

    await test.step('consent screen renders with disclosure text, unchecked checkbox, disabled Continue', () =>
      expectConsentScreenWithDisclosure(page));

    await test.step('checking the box enables Continue; clicking it proceeds to the credential form', () =>
      acceptConsent(page));

    await test.step('credential form renders Depop\'s identifier + secret fields', () =>
      expectCredentialFields(page, 'Depop'));

    await test.step('fill fake credentials and submit', () =>
      submitCredentials(page, 'Depop', identifier, FAKE_PASSWORD));

    await test.step('confirmation view renders with a masked identifier, never the raw fake one', () =>
      expectMaskedConfirmation(page, identifier));

    await test.step('first-win panel renders past the skeleton with health + readiness content', () =>
      expectFirstWinPanelPastSkeleton(page));
  });
});

// ---------------------------------------------------------------------------
// Connections flow — suspended reactivate (Task 14b).
//
// Suspension itself (FR22/FR23) has no tenant-facing trigger -- it's a
// backend kill-switch connector code calls the moment a platform reports a
// ban signal, not something a UI/API action can drive. To exercise the
// Reactivate UI (FR28) this test connects Mercari through the real UI flow
// (mirroring Task 14a's Depop flow, but a different platform so it never
// collides with Task 14a's Depop connection), then reaches past the UI --
// straight into the same scratch SQLite DB the webServer is using -- to call
// recordSuspensionSignal() directly, exactly like the real connector code
// would. Only the suspend step bypasses the UI; the reactivate step is
// driven entirely through the browser, which is the actual thing this test
// verifies.
// ---------------------------------------------------------------------------
test.describe('Connections flow — suspended reactivate', () => {
  test('a suspended Mercari connection shows Reactivate; clicking it transitions to active', async ({
    page,
  }) => {
    const identifier = `e2e-mercari-${uniqueSuffix()}`;

    await test.step('connect Mercari end-to-end via the UI, same step pattern as the Depop flow', () =>
      connectViaUi(page, { id: 'mercari', label: 'Mercari' }, identifier));

    const connection = await test.step('look up the newly-created Mercari connection directly in the scratch DB', () =>
      requireLatestConnection('mercari', 'Mercari connection just created via the UI'));

    await test.step('suspend it directly (bypassing the UI -- there is no tenant-facing suspend action)', () =>
      recordSuspension(connection, 'e2e-test-suspension', 'suspended'));

    await test.step('reload so the UI re-fetches the connection list and shows the suspended status', () =>
      expectSuspendedRowWithReactivate(page, connection.id));

    await test.step('click Reactivate; the badge flips to active without a full page reload', () =>
      reactivateAndExpectActive(page, connection.id));
  });
});

// ---------------------------------------------------------------------------
// Connections flow — revoked reconnect (Task 14c).
//
// Like suspension, revocation itself has no tenant-facing trigger -- it's a
// backend kill-switch signal (recordSuspensionSignal with toStatus 'revoked'),
// not something a UI/API action can drive. To exercise the Reconnect UI this
// test connects Vinted through the real UI flow (mirroring Tasks 14a/14b, but
// a third platform so it never collides with their Depop/Mercari
// connections), then reaches past the UI -- straight into the same scratch
// SQLite DB the webServer is using -- to call recordSuspensionSignal()
// directly with toStatus 'revoked'. From there, the reconnect step is driven
// entirely through the browser: clicking "Reconnect" routes to the same
// consent screen a fresh connect would, and completing that flow again must
// hit POST /api/connections's documented delete-then-recreate behavior for a
// revoked platform -- the old revoked row is deleted and a brand-new row (new
// id, status 'active') is created. This test's core assertion is that the
// post-reconnect row's id differs from the original revoked connection's id.
// ---------------------------------------------------------------------------
test.describe('Connections flow — revoked reconnect', () => {
  test('a revoked Vinted connection shows Reconnect; completing it creates a new connection with a new id', async ({
    page,
  }) => {
    const identifier = `e2e-vinted-${uniqueSuffix()}`;

    await test.step('connect Vinted end-to-end via the UI, same step pattern as the Depop/Mercari flows', () =>
      connectViaUi(page, { id: 'vinted', label: 'Vinted' }, identifier));

    const original = await test.step('look up the newly-created Vinted connection directly in the scratch DB', () =>
      requireLatestConnection('vinted', 'Vinted connection just created via the UI'));

    await test.step('revoke it directly (bypassing the UI -- there is no tenant-facing revoke action)', () =>
      recordSuspension(original, 'e2e-test-revocation', 'revoked'));

    await test.step('reload so the UI re-fetches the connection list and shows the revoked status', () =>
      expectRevokedRowWithReconnect(page, original.id));

    await test.step('click Reconnect; it routes to the consent screen for Vinted', () =>
      startReconnect(page, original.id));

    await test.step('complete the consent + credential flow again with new fake credentials', () =>
      completeReconnect(page, identifier));

    await test.step('the reconnected row in the DB has a NEW id (old revoked row deleted, new one created) and is active', async () => {
      const row = requireLatestConnection('vinted', 'reconnected Vinted connection');
      expect(row.id).not.toBe(original.id);
      expect(row.status).toBe('active');
    });
  });
});
