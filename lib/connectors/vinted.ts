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

// Vinted connector -- the 5 raw `Connector` methods that drive Vinted via
// lib/connectors/playwrightSession.ts's shared Playwright session harness,
// same pattern as lib/connectors/poshmark.ts (that file's doc comments are
// the fuller reference for the withSession/validateSessionReadOnly split).
//
// The one structural difference from Poshmark: Vinted has no durable,
// published ban-risk policy (no documented relist cooldown, no share cap)
// to persist state for. Instead every mutating method self-paces via
// lib/connectors/pacing.ts#enforcePacing('vinted', connectionId) -- an
// in-memory "at most one action per VINTED_ACTION_RATE_LIMIT_MS window per
// connection" limiter (lib/constants.ts) -- called FIRST, before any
// Playwright/browser action, letting ConnectorRateLimitedError propagate
// straight to the caller with the browser never touched.
//
// No live Vinted seller account exists to verify selectors against in this
// increment, so every selector/DOM check below is a best-effort, clearly-
// commented approximation of Vinted's real upload/item-edit pages -- a
// concrete starting shape for a maintainer with real account access to
// correct, not a placeholder no-op.
//
// Selector safety: every locator below is a stable, literal data-testid
// string -- listing content (title/description/price/etc) only ever flows
// into Playwright's VALUE-based APIs (`fill`/`check`/`setInputFiles`),
// never interpolated into a selector string.
//
// No over-scraping: each method navigates to exactly the one page its
// action needs -- the upload form, or a single item's detail/edit page
// keyed by externalListingId -- never the tenant's full closet/wardrobe
// listing index.

/**
 * `page` is typed `unknown` by withSession/validateSessionReadOnly (see
 * playwrightSession.ts) -- cast to the shared PlaywrightPageLike shape at
 * the point of use via `asPage()` below, rather than redeclaring the same
 * Page-subset interface in every connector file.
 */
function asPage(page: unknown): PlaywrightPageLike {
  return page as PlaywrightPageLike;
}

const VINTED_BASE_URL = 'https://www.vinted.com';

/**
 * True if the current page looks like an authenticated Vinted member view
 * (wardrobe/profile chrome visible), rather than a login redirect. Real
 * selector TBD against a live account -- placeholder checks for a "My
 * wardrobe" nav element assumed to exist on Vinted's authenticated header.
 * Any failure reading the page (closed page, navigation error) is treated
 * as "not authenticated" rather than thrown, matching
 * playwrightSession.ts's SessionHooks#validateSession contract (a boolean,
 * never a throw).
 */
async function isAuthenticatedVintedSession(page: PlaywrightPageLike): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="wardrobe-nav-link"]');
  } catch {
    return false;
  }
}

/**
 * Vinted login flow -- exactly one navigate+submit attempt, invoked by
 * withSession() only when the persisted session fails validation.
 * validateSessionReadOnly() never calls this (see playwrightSession.ts).
 * Fills the credential VALUE only, never interpolated into a selector.
 *
 * NOTE: same caveat as poshmark.ts#performPoshmarkLogin -- this
 * increment's credential payload only threads through a single
 * `credential` string (playwrightSession.ts's PlaywrightCredentialPayload).
 * A maintainer wiring this against a live Vinted account will also need a
 * login-identifier (username/email) field on the stored credential to fill
 * the login form's first input -- not modeled here since no connection
 * payload carries one yet.
 */
async function performVintedLogin(page: unknown, credential: string): Promise<void> {
  const p = asPage(page);
  await p.goto(`${VINTED_BASE_URL}/member/login`);
  await p.fill('[data-testid="login-form-password-input"]', credential);
  await p.click('[data-testid="login-form-submit-button"]');
  await p.waitForSelector('[data-testid="wardrobe-nav-link"]', { timeout: 15000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Suspension classification
// ---------------------------------------------------------------------------

/**
 * Best-effort, documented-as-such text patterns Vinted is known to show on
 * a disabled/banned/restricted account. Matched against raw page content
 * (not a specific selector) since the exact banner markup for this state
 * hasn't been verified against a live account in this increment -- a
 * maintainer with account access should replace this with a real selector
 * check once one is confirmed. Deliberately narrow: generic error/timeout
 * text must NOT match here, or a transient navigation hiccup would wrongly
 * suspend a healthy connection.
 */
const VINTED_SUSPENSION_PATTERNS: RegExp[] = [
  /account\s+has\s+been\s+(?:disabled|banned)/i,
  /your\s+account\s+(?:is|has\s+been)\s+(?:temporarily\s+)?(?:blocked|restricted|suspended)/i,
  /this\s+account\s+(?:is|has\s+been)\s+closed/i,
  /violat(?:ed|ion)s?\s+of\s+(?:our|vinted'?s)\s+(?:terms|polic)/i,
];

/**
 * Returns a short, non-secret classification reason if `pageContent`
 * matches a known Vinted suspension/restriction banner, or null otherwise
 * -- including for ambiguous/transient content (a timeout page, a generic
 * error, empty content), which must NEVER be classified as a suspension.
 */
export function classifyVintedSuspension(pageContent: string): string | null {
  if (!pageContent) {
    return null;
  }
  const match = VINTED_SUSPENSION_PATTERNS.find((pattern) => pattern.test(pageContent));
  return match ? `vinted account restriction detected (matched pattern: ${match.source})` : null;
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- delegates the actual validateSession/performLogin
 * composition (and the suspension check riding along with validateSession)
 * to playwrightSession.ts#buildSessionHooks, shared by every Playwright-
 * driven connector; only isAuthenticatedVintedSession/performVintedLogin/
 * classifyVintedSuspension are Vinted-specific.
 */
function buildVintedSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return buildSessionHooks(tenantId, connectionId, {
    isAuthenticated: isAuthenticatedVintedSession,
    performLogin: performVintedLogin,
    classifySuspension: classifyVintedSuspension,
  });
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

/**
 * Fills Vinted's category-specific fields (brand/size/color for clothing).
 * Vinted's core catalog is clothing/fashion -- books have no natural
 * category-specific field beyond what buildListingDescription already
 * covers, so this is a no-op for `book` items. Real Vinted category-picker
 * selectors are a multi-step dropdown/typeahead flow not modeled in detail
 * here -- documented as the maintainer's next step against a live account;
 * this best-effort version fills the fields the upload form is known to
 * expose as plain inputs.
 */
async function fillCategoryFields(page: PlaywrightPageLike, input: ListingInput): Promise<void> {
  if (input.category !== 'clothing') {
    return;
  }
  await fillClothingFields(page, input.details as ClothingDetails, {
    brand: '[data-testid="upload-brand-input"]',
    size: '[data-testid="upload-size-input"]',
    color: '[data-testid="upload-color-input"]',
  });
}

/**
 * Uploads listing photos -- delegates the sort/path-extraction/
 * setInputFiles plumbing to playwrightSession.ts#uploadSortedPhotos,
 * shared by every photo-uploading connector; only the selector is
 * Vinted-specific.
 */
async function uploadListingPhotos(page: PlaywrightPageLike, photos: ListingInput['photos']): Promise<void> {
  await uploadSortedPhotos(page, photos, '[data-testid="upload-photo-input"]');
}

/**
 * Vinted item URLs are shaped https://www.vinted.com/items/<itemId>-<slug>
 * -- the id is the first path segment after /items/. Best-effort/
 * documented shape, not confirmed against a live account.
 */
function extractListingIdFromUrl(url: string): string | null {
  const match = url.match(/\/items\/(\d+)(?:-[^/]*)?\/?$/);
  return match ? match[1] : null;
}

function itemPageUrl(externalListingId: string): string {
  return `${VINTED_BASE_URL}/items/${externalListingId}`;
}

function itemEditPageUrl(externalListingId: string): string {
  return `${VINTED_BASE_URL}/items/${externalListingId}/edit`;
}

/**
 * True if the current page shows Vinted's "item not found" state -- e.g.
 * the item was already deleted, or externalListingId is stale/wrong.
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
  // 1. Navigate to Vinted's upload/create-listing form -- the only page
  //    this action ever visits besides the post-submit confirmation
  //    redirect; it never enumerates the seller's wardrobe as a side
  //    effect.
  await page.goto(`${VINTED_BASE_URL}/items/new`);

  // 2. Fill listing fields using VALUE-based locators only -- title/
  //    description/price values are passed as fill() arguments, never
  //    interpolated into a selector string.
  await page.fill('[data-testid="upload-title-input"]', input.title);
  await page.fill('[data-testid="upload-description-input"]', buildListingDescription(input));
  await page.fill('[data-testid="upload-price-input"]', formatPriceDollars(input.priceCents));

  // 3. Category-specific fields (size/brand/color for clothing; no-op for
  //    books).
  await fillCategoryFields(page, input);

  // 4. Photos -- Vinted requires at least one image.
  await uploadListingPhotos(page, input.photos);

  // 5. Submit.
  await page.click('[data-testid="upload-submit-button"]');
  await page.waitForURL(/\/items\/\d+/).catch(() => undefined);

  // 6. Extract the new item id from the resulting URL. Falls back to this
  //    app's own itemId only if the URL couldn't be parsed -- a best-effort
  //    safety net, not the expected path.
  const externalListingId = extractListingIdFromUrl(page.url()) ?? input.itemId;

  return { externalListingId };
}

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  // Pacing gate FIRST -- before any Playwright/browser action. Vinted has
  // no published, durable ban-risk policy to persist state for (unlike
  // Poshmark's relist cooldown), so this in-memory
  // enforcePacing('vinted', connectionId) self-pacing check is the only
  // gate; letting ConnectorRateLimitedError propagate straight out means a
  // paced-over connection never even opens a browser context.
  enforcePacing('vinted', input.connectionId);

  return withSession(
    input.tenantId,
    input.connectionId,
    (page) => createListingAction(asPage(page), input),
    buildVintedSessionHooks(input.tenantId, input.connectionId),
  );
}

async function updateListingAction(
  page: PlaywrightPageLike,
  externalListingId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Navigates to exactly the one item's edit page -- never the wardrobe
  // listing index.
  await page.goto(itemEditPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  if (patch.title !== undefined) {
    await page.fill('[data-testid="upload-title-input"]', patch.title);
  }
  if (patch.priceCents !== undefined) {
    await page.fill('[data-testid="upload-price-input"]', formatPriceDollars(patch.priceCents));
  }
  // patch.details (size/brand/condition/etc) maps onto the same
  // category-specific fields fillCategoryFields fills at creation time --
  // left as a maintainer TODO against a live account, since an EXISTING
  // item's edit-form field selectors aren't guaranteed identical to the
  // upload form's.

  await page.click('[data-testid="upload-save-button"]');
  return { ok: true };
}

export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  // Pacing gate FIRST -- see createListing's doc comment.
  enforcePacing('vinted', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => updateListingAction(asPage(page), externalListingId, patch),
    buildVintedSessionHooks(tenantId, connectionId),
  );
}

async function markSoldAction(page: PlaywrightPageLike, externalListingId: string): Promise<MarkSoldResult> {
  // Navigates to exactly the one item's detail page -- never the wardrobe
  // listing index.
  await page.goto(itemPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="item-mark-as-sold-button"]');
  return { ok: true };
}

export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  // Pacing gate FIRST -- see createListing's doc comment.
  enforcePacing('vinted', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => markSoldAction(asPage(page), externalListingId),
    buildVintedSessionHooks(tenantId, connectionId),
  );
}

async function delistAction(page: PlaywrightPageLike, externalListingId: string): Promise<DelistResult> {
  // Navigates to exactly the one item's detail page -- never the wardrobe
  // listing index.
  await page.goto(itemPageUrl(externalListingId));

  if (await isItemNotFound(page)) {
    return { ok: false, reason: 'not_found' };
  }

  await page.click('[data-testid="item-delist-button"]');
  return { ok: true };
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  // Pacing gate FIRST -- see createListing's doc comment. Unlike
  // poshmark.ts's delist, there is no durable relist-cooldown bookkeeping
  // to record afterward -- Vinted's only ban-risk mitigation is the
  // pacing window already enforced above.
  enforcePacing('vinted', connectionId);

  return withSession(
    tenantId,
    connectionId,
    (page) => delistAction(asPage(page), externalListingId),
    buildVintedSessionHooks(tenantId, connectionId),
  );
}

/**
 * Read-only session health check -- calls validateSessionReadOnly, NEVER
 * withSession and NEVER enforcePacing, so a health check can never trigger
 * a fresh login attempt (playwrightSession.ts's design; see that
 * function's doc comment) nor consume a connection's pacing window --
 * pacing exists to throttle mutating actions against the live platform,
 * not read-only probes.
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  return validateSessionReadOnly(tenantId, connectionId, buildVintedSessionHooks(tenantId, connectionId));
}

/**
 * Raw (ungated) Vinted Connector implementation -- wrap with
 * gate.ts#buildConnector('vinted', vintedConnector) before exposing to
 * callers, same convention as every other platform (amazon.ts/ebay.ts/
 * etsy.ts/poshmark.ts).
 */
export const vintedConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
