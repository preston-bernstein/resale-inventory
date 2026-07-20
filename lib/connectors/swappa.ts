import {
  withSession,
  validateSessionReadOnly,
  buildSessionHooks,
  isElementVisible,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import { assertCategorySupported } from '@/lib/constants';
import type { ElectronicsDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
  UpdateListingResult,
  MarkSoldResult,
  DelistResult,
  HealthResult,
} from '@/lib/connectors/types';
import { buildListingDescription, formatPriceDollars } from '@/lib/connectors/listingContent';

// Swappa connector -- the 5 shared Connector methods (createListing/
// updateListing/markSold/delist/checkConnectionHealth) driving Swappa via
// lib/connectors/playwrightSession.ts's shared Playwright session harness,
// same pattern as grailed.ts/mercari.ts (that pair are the reference
// siblings for the Playwright/withSession shape).
//
// Task 13a implemented createListing; Task 13b (this increment) adds real
// implementations for updateListing/markSold/delist/checkConnectionHealth,
// modeled on grailed.ts's updateListingAction/markSoldAction/delistAction/
// checkConnectionHealth -- same withSession/enforcePacing/validateSessionReadOnly
// wiring, targeting Swappa's listing pages instead of Grailed's.
//
// Swappa is electronics-only: lib/constants.ts's PLATFORM_CATEGORY_SUPPORT
// entry for 'swappa' is `['electronics']`, and createListing's FIRST
// statement below is assertCategorySupported('swappa', input.category) --
// before any pacing, session, or Playwright logic -- so a book/clothing
// ListingInput is rejected immediately with UnsupportedCategoryError,
// never opening a browser context for a category Swappa doesn't support.
//
// Like Grailed/Mercari, Swappa has no durable, published ban-risk policy to
// mirror (no documented relist cooldown, no share cap) -- so there is no
// persistence layer here at all. Instead, every mutating action (create/
// update/markSold/delist) is paced via lib/connectors/pacing.ts's
// enforcePacing('swappa', connectionId), an in-memory conservative
// self-imposed rate limit (SWAPPA_ACTION_RATE_LIMIT_MS, lib/constants.ts)
// standing in for a policy Swappa hasn't published. enforcePacing is
// synchronous and runs immediately after the category check -- before any
// Playwright/browser action -- so a paced-out call never opens a session;
// ConnectorRateLimitedError propagates straight to the caller.
//
// 'swappa' is a member of pacing.ts's PacedPlatform union (alongside
// PACING_WINDOW_MS.swappa, wired to SWAPPA_ACTION_RATE_LIMIT_MS in
// lib/constants.ts), so enforcePacing('swappa', ...) below type-checks the
// same as grailed.ts's enforcePacing('grailed', connectionId).
//
// No live Swappa seller account exists to verify selectors against in this
// increment, so every selector/DOM check below is a best-effort, clearly-
// commented approximation of Swappa's real sell/listing-edit pages -- a
// concrete starting shape for a maintainer with real account access to
// correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/device specs/etc)
// only ever flows into Playwright's VALUE-based APIs (`fill`/`check`),
// never interpolated into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the sell/create-listing form, or a single listing's
// detail/edit page keyed by externalListingId -- never the seller's full
// listing index.

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at
 * the point of use via `asPage()` below, rather than redeclaring the same
 * Page-subset interface in every connector file. Swappa doesn't currently
 * call setInputFiles (no photo-upload step wired up yet) -- the unused
 * method on the shared shape is harmless (see playwrightSession.ts's
 * PlaywrightPageLike doc comment).
 */
function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

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

/**
 * True if the current page shows Swappa's "listing not found" state -- e.g.
 * the listing was already deleted/sold-and-removed, or externalListingId is
 * stale/wrong. Checked via a locator's visibility rather than raw content
 * matching (unlike suspension classification, which by necessity scans raw
 * content to catch banner text wherever it renders) -- this is a single,
 * stable, expected element. Real selector TBD against a live account, same
 * best-effort convention as every other selector in this file.
 */
async function isItemNotFound(page: PlaywrightPageLike): Promise<boolean> {
  return isElementVisible(page, '[data-testid="listing-not-found"]');
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

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  // Category-rejection-as-first-statement -- before any pacing, session, or
  // Playwright logic. Swappa's PLATFORM_CATEGORY_SUPPORT entry
  // (lib/constants.ts) is `['electronics']` only, so this throws
  // UnsupportedCategoryError immediately for a book/clothing ListingInput,
  // never opening a browser context for a category Swappa doesn't support.
  assertCategorySupported('swappa', input.category);

  // Pacing gate NEXT -- still before any Playwright/browser action. Swappa
  // has no published rate-limit policy, so enforcePacing's conservative
  // self-imposed window is the only thing standing between this call and a
  // real create -- ConnectorRateLimitedError must propagate untouched, and
  // no browser context may ever be opened for a paced-out call.
  enforcePacing('swappa', input.connectionId);

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildSwappaSessionHooks(input.tenantId, input.connectionId),
  );
}

async function updateListingAction(
  page: PlaywrightPageLike,
  externalListingId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Navigates to exactly the one listing's edit page -- never the seller's
  // full listing index.
  await page.goto(listingEditPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  if (patch.title !== undefined) {
    await page.fill('[data-testid="listing-title-input"]', patch.title);
  }
  if (patch.priceCents !== undefined) {
    await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(patch.priceCents));
  }
  // patch.details (device type/brand/model/etc) maps onto the same
  // device-spec fields fillDeviceSpecFields fills at creation time -- left
  // as a maintainer TODO against a live account, since an EXISTING
  // listing's edit-form field selectors aren't guaranteed identical to the
  // create-listing form's.

  await page.click('[data-testid="listing-save-button"]');
  return { ok: true };
}

export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Pacing gate FIRST -- before any Playwright/browser action. See the
  // enforcePacing note above createListing: Swappa has no published
  // rate-limit policy, so this conservative self-imposed window is the only
  // thing standing between this call and a real update --
  // ConnectorRateLimitedError must propagate untouched, and no browser
  // context may ever be opened for a paced-out call.
  enforcePacing('swappa', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildSwappaSessionHooks(tenantId, connectionId),
  );
}

async function markSoldAction(page: PlaywrightPageLike, externalListingId: string): Promise<MarkSoldResult> {
  // Navigates to exactly the one listing's detail page -- never the
  // seller's full listing index.
  await page.goto(listingPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="listing-mark-as-sold-button"]');
  return { ok: true };
}

export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  enforcePacing('swappa', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildSwappaSessionHooks(tenantId, connectionId),
  );
}

async function delistAction(page: PlaywrightPageLike, externalListingId: string): Promise<DelistResult> {
  // Navigates to exactly the one listing's detail page -- never the
  // seller's full listing index.
  await page.goto(listingPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="listing-delist-button"]');
  return { ok: true };
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  enforcePacing('swappa', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildSwappaSessionHooks(tenantId, connectionId),
  );
}

/**
 * Read-only session health check -- calls validateSessionReadOnly, NEVER
 * withSession, and NEVER enforcePacing (pacing exists solely to throttle
 * mutating platform actions; a read-only health probe isn't one). So a
 * health check can never trigger a fresh login attempt or consume a
 * connection's pacing window (playwrightSession.ts's design; see that
 * function's doc comment).
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  return validateSessionReadOnly(tenantId, connectionId, buildSwappaSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Swappa Connector implementation -- wrap with
 * gate.ts#buildConnector('swappa', swappaConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * etsy.ts/grailed.ts/mercari.ts).
 */
export const swappaConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
