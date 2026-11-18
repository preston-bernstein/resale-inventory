import {
  buildSessionHooks,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import {
  asPage,
  buildPlaywrightConnector,
  pacedGuards,
  type PlaywrightSite,
} from '@/lib/connectors/playwrightConnector';
import type { ElectronicsDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
} from '@/lib/connectors/types';
import { buildListingDescription, formatPriceDollars } from '@/lib/connectors/listingContent';

// Swappa connector. It drives Swappa through the shared Playwright module;
// see playwrightConnector.ts for the 5 Connector methods, the guards and the
// selector rules.
//
// Swappa sells electronics only (PLATFORM_CATEGORY_SUPPORT in
// lib/constants.ts), so createListing rejects a book or clothing input with
// UnsupportedCategoryError before it paces or opens a browser.
//
// Swappa publishes no relist-cooldown or share-cap policy, so there is no
// durable ban-risk state. The one mitigation is enforcePacing('swappa',
// connectionId), which runs before any browser action in the 4 mutating
// methods.
//
// No live Swappa seller account exists, so every selector below is a best-effort
// guess for a maintainer with account access to correct.

// Best-effort placeholder, matching the same convention every other
// Playwright connector in this repo already follows (grailed.ts/
// mercari.ts/etc) -- no live Swappa seller account exists to verify this
// against.
const SWAPPA_BASE_URL = 'https://swappa.com';

/**
 * True if the current page looks like an authenticated Swappa seller view
 * (account/sell-dashboard chrome visible), rather than a login/signin
 * redirect. Real selector TBD against a live account -- placeholder checks
 * for an account nav element assumed to exist on Swappa's authenticated
 * header. Any failure reading the page (closed page, navigation error) is
 * treated as "not authenticated" rather than thrown, matching
 * playwrightSession.ts's SessionHooks#validateSession contract (a boolean,
 * never a throw).
 */
async function isAuthenticatedSwappaSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="account-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Swappa login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Swappa account will also need a login-identifier (username/email)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performSwappaLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${SWAPPA_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="account-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Swappa is known to show on
 * a banned/suspended/under-review account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const SWAPPA_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+banned/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?suspended/i,
  /account\s+is\s+under\s+review/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|swappa'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Swappa suspension/ban/under-review banner, or null
 * otherwise -- including for ambiguous/transient content (a timeout page,
 * a generic error, empty content), which must NEVER be classified as a
 * suspension.
 */
export function classifySwappaSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = SWAPPA_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `swappa account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedSwappaSession/performSwappaLogin/
 * classifySwappaSuspension are Swappa-specific.
 */
function buildSwappaSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedSwappaSession,
    performLogin: performSwappaLogin,
    classifySuspension: classifySwappaSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Swappa's device-spec fields (device type/brand/model). Swappa is an
 * electronics-only marketplace (enforced by assertCategorySupported before
 * this is ever reached), so unlike grailed.ts/mercari.ts's fillCategoryFields
 * this never branches on `input.category` -- `input.details` is always
 * ElectronicsDetails here. Real Swappa listing-form selectors (a multi-step
 * device-model picker in practice) are a best-effort approximation, same
 * convention as every other connector's category-field fill -- a concrete
 * starting shape for a maintainer with real account access to correct, not
 * a placeholder no-op. The remaining spec fields (processor/ram/storage/
 * screen size/battery health/cycle count) ride along in the free-text
 * description via buildListingDescription rather than separate structured
 * fields, mirroring how the other detail-heavy category (books' isbn/
 * publisher/author) is handled elsewhere in this codebase.
 */
async function fillDeviceSpecFields(page: PlaywrightPageLike, details: ElectronicsDetails): Promise<void> {
  await page.fill('[data-testid="listing-device-type-input"]', details.device_type);
  await page.fill('[data-testid="listing-brand-input"]', details.brand);
  await page.fill('[data-testid="listing-model-input"]', details.model);
}

/**
 * Swappa listing URLs are shaped
 * https://swappa.com/listings/<listingId>-<title-slug> -- the id is the
 * first hyphen-delimited segment of the last path component. Best-effort/
 * documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/listings\/(\d+)(?:-[^/]*)?\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${SWAPPA_BASE_URL}/listings/${externalListingId}`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${SWAPPA_BASE_URL}/listings/${externalListingId}/edit`;
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // Navigate to Swappa's "Sell"/create-listing form -- the only page this
  // action ever visits besides the post-submit confirmation redirect; it
  // never enumerates the seller's full listing index as a side effect.
  await page.goto(`${SWAPPA_BASE_URL}/sell`);

  // Fill listing fields using VALUE-based locators only -- title/
  // description/price values are passed as fill() arguments, never
  // interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // Device-spec fields (device type/brand/model). Always electronics --
  // assertCategorySupported (createListing's first statement) already
  // rejected any other category before this action ever runs.
  await fillDeviceSpecFields(page, input.details as ElectronicsDetails);

  // Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/listings\//).catch(() => undefined);

  // Extract the new listing id from the resulting URL. Falls back to this
  // app's own itemId only if the URL couldn't be parsed -- a best-effort
  // safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

const SITE: PlaywrightSite = {
  platform: 'swappa',
  buildHooks: buildSwappaSessionHooks,
  detailPageUrl: listingPageUrl,
  editPageUrl: listingEditPageUrl,
  selectors: {
    notFound: '[data-testid="listing-not-found"]',
    titleInput: '[data-testid="listing-title-input"]',
    priceInput: '[data-testid="listing-price-input"]',
    saveButton: '[data-testid="listing-save-button"]',
    markSoldButton: '[data-testid="listing-mark-as-sold-button"]',
    delistButton: '[data-testid="listing-delist-button"]',
  },
};

/**
 * Raw (ungated) Swappa Connector implementation -- wrap with
 * gate.ts#buildConnector('swappa', swappaConnector) before exposing to
 * callers, same convention as every other platform.
 */
export const swappaConnector: Connector = buildPlaywrightConnector(SITE, createListingAction, pacedGuards('swappa'));

export const { createListing, updateListing, markSold, delist, checkConnectionHealth } = swappaConnector;
