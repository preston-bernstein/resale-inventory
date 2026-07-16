import {
  withSession,
  validateSessionReadOnly,
  buildSessionHooks,
  fillClothingFields,
  isElementVisible,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import type { ClothingDetails } from '@/lib/types';
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

// Grailed connector -- the 5 shared Connector methods (createListing/
// updateListing/markSold/delist/checkConnectionHealth) driving Grailed via
// lib/connectors/playwrightSession.ts's shared Playwright session harness,
// same pattern as poshmark.ts (that file's the reference sibling for the
// Playwright/withSession shape).
//
// Unlike Poshmark, Grailed has no durable, published ban-risk policy to
// mirror (no documented relist cooldown, no share cap) -- so there is no
// persistence layer here at all. Instead, every mutating action (create/
// update/markSold/delist) is paced via lib/connectors/pacing.ts's
// enforcePacing('grailed', connectionId), an in-memory conservative
// self-imposed rate limit (GRAILED_ACTION_RATE_LIMIT_MS, lib/constants.ts)
// standing in for a policy Grailed hasn't published. enforcePacing is
// synchronous and is always the FIRST thing each mutating method does --
// before any Playwright/browser action -- so a paced-out call never opens a
// session; ConnectorRateLimitedError propagates straight to the caller.
//
// No live Grailed seller account exists to verify selectors against in this
// increment, so every selector/DOM check below is a best-effort, clearly-
// commented approximation of Grailed's real sell/listing-edit pages -- a
// concrete starting shape for a maintainer with real account access to
// correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/etc) only ever flows
// into Playwright's VALUE-based APIs (`fill`/`check`), never interpolated
// into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the sell/create-listing form, or a single listing's
// detail/edit page keyed by externalListingId -- never the seller's full
// listing index.

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at
 * the point of use via `asPage()` below, rather than redeclaring the same
 * Page-subset interface in every connector file. Grailed doesn't currently
 * call setInputFiles (no photo-upload step wired up yet) -- the unused
 * method on the shared shape is harmless (see playwrightSession.ts's
 * PlaywrightPageLike doc comment).
 */
function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

const GRAILED_BASE_URL = 'https://www.grailed.com';

/**
 * True if the current page looks like an authenticated Grailed seller view
 * (selling/dashboard chrome visible), rather than a login/signin redirect.
 * Real selector TBD against a live account -- placeholder checks for a
 * "sell" nav element assumed to exist on Grailed's authenticated header.
 * Any failure reading the page (closed page, navigation error) is treated
 * as "not authenticated" rather than thrown, matching
 * playwrightSession.ts's SessionHooks#validateSession contract (a boolean,
 * never a throw).
 */
async function isAuthenticatedGrailedSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="sell-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Grailed login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Grailed account will also need a login-identifier (username/email)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performGrailedLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${GRAILED_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="sell-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Grailed is known to show on
 * a banned/suspended/under-review account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const GRAILED_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+banned/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?suspended/i,
  /account\s+is\s+under\s+review/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|grailed'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Grailed suspension/ban/under-review banner, or null
 * otherwise -- including for ambiguous/transient content (a timeout page,
 * a generic error, empty content), which must NEVER be classified as a
 * suspension.
 */
export function classifyGrailedSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = GRAILED_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `grailed account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedGrailedSession/performGrailedLogin/
 * classifyGrailedSuspension are Grailed-specific.
 */
function buildGrailedSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedGrailedSession,
    performLogin: performGrailedLogin,
    classifySuspension: classifyGrailedSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Grailed's category-specific fields (brand/size/color for clothing --
 * Grailed is a menswear/streetwear-focused marketplace with no book
 * category in practice, but this connector still threads `details` through
 * generically like every other platform connector for a uniform
 * ListingInput contract). Real Grailed category-picker selectors are a
 * multi-step dropdown/typeahead flow not modeled in detail here --
 * documented as the maintainer's next step against a live account; this
 * best-effort version fills the fields the sell form is known to expose as
 * plain inputs.
 */
async function fillCategoryFields(page: PlaywrightPageLike, input: ListingInput): Promise<void> {
  if (input.category !== 'clothing') {
    return;
  }
  await fillClothingFields(page, input.details as ClothingDetails, {
    brand: '[data-testid="listing-brand-input"]',
    size: '[data-testid="listing-size-input"]',
    color: '[data-testid="listing-color-input"]',
  });
}

/**
 * Grailed listing URLs are shaped
 * https://www.grailed.com/listings/<listingId>-<title-slug> -- the id is
 * the first hyphen-delimited segment of the last path component.
 * Best-effort/documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/listings\/(\d+)(?:-[^/]*)?\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${GRAILED_BASE_URL}/listings/${externalListingId}`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${GRAILED_BASE_URL}/listings/${externalListingId}/edit`;
}

/**
 * True if the current page shows Grailed's "listing not found" state --
 * e.g. the listing was already deleted/sold-and-removed, or
 * externalListingId is stale/wrong. Checked via a locator's visibility
 * rather than raw content matching (unlike suspension classification,
 * which by necessity scans raw content to catch banner text wherever it
 * renders) -- this is a single, stable, expected element.
 */
async function isItemNotFound(page: PlaywrightPageLike): Promise<boolean> {
  return isElementVisible(page, '[data-testid="listing-not-found"]');
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // Navigate to Grailed's "Sell"/create-listing form -- the only page this
  // action ever visits besides the post-submit confirmation redirect; it
  // never enumerates the seller's full listing index as a side effect.
  await page.goto(`${GRAILED_BASE_URL}/sell`);

  // Fill listing fields using VALUE-based locators only -- title/
  // description/price values are passed as fill() arguments, never
  // interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // Category-specific fields (size/brand/color for clothing).
  await fillCategoryFields(page, input);

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
  // Pacing gate FIRST -- before any Playwright/browser action. Grailed has
  // no published rate-limit policy, so enforcePacing's conservative
  // self-imposed window is the only thing standing between this call and a
  // real create -- ConnectorRateLimitedError must propagate untouched, and
  // no browser context may ever be opened for a paced-out call.
  enforcePacing('grailed', input.connectionId);

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildGrailedSessionHooks(input.tenantId, input.connectionId),
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
  // patch.details (size/brand/condition/etc) maps onto the same
  // category-specific fields fillCategoryFields fills at creation time --
  // left as a maintainer TODO against a live account, since an EXISTING
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
  enforcePacing('grailed', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildGrailedSessionHooks(tenantId, connectionId),
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
  enforcePacing('grailed', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildGrailedSessionHooks(tenantId, connectionId),
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
  enforcePacing('grailed', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildGrailedSessionHooks(tenantId, connectionId),
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
  return validateSessionReadOnly(tenantId, connectionId, buildGrailedSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Grailed Connector implementation -- wrap with
 * gate.ts#buildConnector('grailed', grailedConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * etsy.ts/poshmark.ts).
 */
export const grailedConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
