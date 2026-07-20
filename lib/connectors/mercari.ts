import {
  withSession,
  validateSessionReadOnly,
  buildSessionHooks,
  fillClothingFields,
  uploadSortedPhotos,
  isElementVisible,
  type SessionHooks,
  type PlaywrightPageLike,
} from '@/lib/connectors/playwrightSession';
import { enforcePacing } from '@/lib/connectors/pacing';
import { assertCategorySupported } from '@/lib/constants';
import type { ClothingDetails, ElectronicsDetails } from '@/lib/types';
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

// Mercari connector -- the 5 shared Connector methods (createListing/
// updateListing/markSold/delist/checkConnectionHealth) that drive Mercari
// via lib/connectors/playwrightSession.ts's shared Playwright session
// harness, same pattern as poshmark.ts.
//
// UNLIKE Poshmark, Mercari has no published/documented ban-risk threshold
// (no relist cooldown, no share cap) to persist durable state for --
// lib/connectors/pacing.ts's comment on PacedPlatform explains why Mercari
// is one of the "no published rate-limit policy" platforms instead. So
// rather than a durable, SQLite-backed cooldown table (poshmark.ts's
// poshmark_delist_events/poshmark_share_events), every mutating method here
// calls lib/connectors/pacing.ts#enforcePacing('mercari', connectionId)
// FIRST -- before any Playwright/browser action -- to self-impose a
// conservative "1 action per MERCARI_ACTION_RATE_LIMIT_MS window" pace per
// connection. enforcePacing throws ConnectorRateLimitedError synchronously
// (in-memory rate limiter, lib/rateLimit.ts) and that error is left to
// propagate untouched -- callers see it exactly as pacing.ts defines it.
//
// No live Mercari seller account exists to verify selectors against in this
// increment, so every selector/DOM check below is a best-effort, clearly-
// commented approximation of Mercari's real create-listing/item pages -- a
// concrete starting shape for a maintainer with real account access to
// correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/etc) only ever flows
// into Playwright's VALUE-based APIs (`fill`/`check`/`setInputFiles`), never
// interpolated into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the create-listing form, or a single listing's
// detail/edit page keyed by externalListingId -- never the seller's full
// item index/listing history.

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at
 * the point of use via `asPage()` below, rather than redeclaring the same
 * Page-subset interface in every connector file.
 */
function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

const MERCARI_BASE_URL = 'https://www.mercari.com';

/**
 * True if the current page looks like an authenticated Mercari seller view
 * (account/sell-dashboard chrome visible), rather than a login/signin
 * redirect. Real selector TBD against a live account -- placeholder checks
 * for a "My Page"/account nav element assumed to exist on Mercari's
 * authenticated header. Any failure reading the page (closed page,
 * navigation error) is treated as "not authenticated" rather than thrown,
 * matching playwrightSession.ts's SessionHooks#validateSession contract (a
 * boolean, never a throw).
 */
async function isAuthenticatedMercariSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="account-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Mercari login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: this increment's credential payload (playwrightSession.ts's
 * PlaywrightCredentialPayload) only threads through a single `credential`
 * string, matching every other Playwright-driven connector's
 * SessionHooks#performLogin contract. A maintainer wiring this against a
 * live Mercari account will also need a login-identifier (email/phone)
 * field on the stored credential to fill the login form's first input --
 * not modeled here since no connection payload carries one yet.
 */
async function performMercariLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${MERCARI_BASE_URL}/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="account-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Mercari is known to show on
 * a deactivated/suspended/restricted account. Matched against raw page
 * content (not a specific selector) since the exact banner markup for this
 * state hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const MERCARI_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+(?:deactivated|disabled)/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?(?:restricted|suspended|locked)/i,
  /account\s+suspension/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|mercari'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Mercari suspension/restriction banner, or null otherwise
 * -- including for ambiguous/transient content (a timeout page, a generic
 * error, empty content), which must NEVER be classified as a suspension.
 */
export function classifyMercariSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = MERCARI_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `mercari account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedMercariSession/performMercariLogin/
 * classifyMercariSuspension are Mercari-specific.
 */
function buildMercariSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedMercariSession,
    performLogin: performMercariLogin,
    classifySuspension: classifyMercariSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Mercari's category-specific fields (brand/size/color for clothing,
 * brand/model for electronics, a "Books" category checkbox for books). Real
 * Mercari category-picker selectors are a multi-step dropdown/typeahead flow
 * not modeled in detail here -- documented as the maintainer's next step
 * against a live account; this best-effort version fills the fields the
 * create-listing form is known to expose as plain inputs.
 */
async function fillCategoryFields(page: PlaywrightPageLike, input: ListingInput): Promise<void> {
  if (input.category === 'clothing') {
    await fillClothingFields(page, input.details as ClothingDetails, {
      brand: '[data-testid="listing-brand-input"]',
      size: '[data-testid="listing-size-input"]',
      color: '[data-testid="listing-color-input"]',
    });
    return;
  }

  if (input.category === 'electronics') {
    await fillElectronicsFields(page, input.details as ElectronicsDetails);
    return;
  }

  await page.check('[data-testid="listing-category-books"]');
}

/**
 * Fills Mercari's electronics-specific fields (brand/model). The remaining
 * spec fields (processor/ram/storage/screen size/battery health/cycle
 * count) and condition ride along in the free-text description via
 * buildListingDescription rather than separate structured fields, same
 * convention as swappa.ts's fillDeviceSpecFields.
 */
async function fillElectronicsFields(page: PlaywrightPageLike, details: ElectronicsDetails): Promise<void> {
  await page.fill('[data-testid="listing-brand-input"]', details.brand);
  await page.fill('[data-testid="listing-model-input"]', details.model);
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Mercari-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="listing-photo-upload-input"]');
}

/**
 * Mercari listing URLs are shaped
 * https://www.mercari.com/us/item/<listingId>/ -- the id is the last
 * slash-delimited path segment. Best-effort/documented shape, not confirmed
 * against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/item\/([a-zA-Z0-9]+)\/?$/);
  return match ? match[1] : null;
}

function listingPageUrl(externalListingId: string): string {
  return `${MERCARI_BASE_URL}/us/item/${externalListingId}/`;
}

function listingEditPageUrl(externalListingId: string): string {
  return `${MERCARI_BASE_URL}/us/sell/edit/${externalListingId}/`;
}

/**
 * True if the current page shows Mercari's "item not found" state -- e.g.
 * the listing was already deleted, or externalListingId is stale/wrong.
 * Checked via a locator's visibility rather than raw content matching
 * (unlike suspension classification, which by necessity scans raw content
 * to catch banner text wherever it renders) -- this is a single, stable,
 * expected element.
 */
async function isItemNotFound(page: PlaywrightPageLike): Promise<boolean> {
  return isElementVisible(page, '[data-testid="item-not-found"]');
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: PlaywrightPageLike, input: ListingInput): Promise<CreateListingResult> {
  // 1. Navigate to Mercari's "Sell"/create-listing form -- the only page
  //    this action ever visits besides the post-submit confirmation
  //    redirect; it never enumerates the seller's full item index as a
  //    side effect.
  await page.goto(`${MERCARI_BASE_URL}/sell/`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="listing-title-input"]', input.title);
  await page.fill('[data-testid="listing-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="listing-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand for clothing, brand/model for
  //    electronics, category for books).
  await fillCategoryFields(page, input);

  // 4. Photos -- Mercari requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="list-item-submit-button"]');
  await page.waitForURL(/\/item\//).catch(() => undefined);

  // 6. Extract the new listing id from the resulting URL. Falls back to
  //    this app's own itemId only if the URL couldn't be parsed -- a
  //    best-effort safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  assertCategorySupported('mercari', input.category);

  // Pacing gate FIRST -- before any Playwright/browser action. Mercari has
  // no published/documented ban-risk threshold to persist durable state
  // for (see this file's top-of-file comment), so enforcePacing's
  // in-memory "1 action per MERCARI_ACTION_RATE_LIMIT_MS window" self-pace
  // is the only throttle here. Lets ConnectorRateLimitedError propagate
  // untouched.
  enforcePacing('mercari', input.connectionId);

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildMercariSessionHooks(input.tenantId, input.connectionId),
  );
}

async function updateListingAction(
  page: PlaywrightPageLike,
  externalListingId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Navigates to exactly the one listing's edit page -- never the seller's
  // full item index.
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
  // Pacing gate FIRST -- see createListing's comment above.
  enforcePacing('mercari', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildMercariSessionHooks(tenantId, connectionId),
  );
}

async function markSoldAction(page: PlaywrightPageLike, externalListingId: string): Promise<MarkSoldResult> {
  // Navigates to exactly the one listing's detail page -- never the
  // seller's full item index.
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
  // Pacing gate FIRST -- see createListing's comment above.
  enforcePacing('mercari', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildMercariSessionHooks(tenantId, connectionId),
  );
}

async function delistAction(page: PlaywrightPageLike, externalListingId: string): Promise<DelistResult> {
  // Navigates to exactly the one listing's detail page -- never the
  // seller's full item index.
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
  // Pacing gate FIRST -- see createListing's comment above. Unlike
  // poshmark.ts's delist, there is no durable relist-cooldown bookkeeping
  // to start here -- Mercari has no published cooldown policy to persist
  // (this file's top-of-file comment).
  enforcePacing('mercari', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildMercariSessionHooks(tenantId, connectionId),
  );
}

/**
 * Read-only session health check -- calls validateSessionReadOnly, NEVER
 * withSession, and NEVER enforcePacing (a health check isn't a mutating
 * platform action, so it isn't paced), so a health check can never trigger
 * a fresh login attempt (playwrightSession.ts's design; see that function's
 * doc comment) nor consume a connection's pacing budget.
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  return validateSessionReadOnly(tenantId, connectionId, buildMercariSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Mercari Connector implementation -- wrap with
 * gate.ts#buildConnector('mercari', mercariConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * etsy.ts/poshmark.ts).
 */
export const mercariConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
