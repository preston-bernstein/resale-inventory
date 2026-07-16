import { recordSuspensionSignal } from '@/lib/connections';
import { withSession, validateSessionReadOnly, type SessionHooks } from '@/lib/connectors/playwrightSession';
import { scrubSecrets } from '@/lib/connectors/scrub';
import { enforcePacing } from '@/lib/connectors/pacing';
import type { BookDetails, ClothingDetails } from '@/lib/types';
import type {
  Connector,
  ListingInput,
  CreateListingResult,
  UpdateListingResult,
  MarkSoldResult,
  DelistResult,
  HealthResult,
} from '@/lib/connectors/types';

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
 * Minimal value-based subset of Playwright's `Page` API this file touches.
 * Declared locally -- like playwrightSession.ts itself -- so this module
 * never needs a static import of the `playwright` package; `withSession`/
 * `validateSessionReadOnly` hand back `page` typed `unknown`, cast to this
 * shape at the point of use via `asPage()` below.
 */
interface MercariPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForURL(pattern: string | RegExp): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
}

function asPage(page: unknown): MercariPage {
  return page as MercariPage;
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
async function isAuthenticatedMercariSession(page: MercariPage): Promise<boolean> {
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
 * Reads the current page's content and, ONLY on a positive
 * classifyMercariSuspension() match, records a suspension signal via
 * lib/connections.ts#recordSuspensionSignal with a scrubbed reason. Any
 * failure reading page content (navigation timeout, closed page, etc) is
 * swallowed here and treated as "nothing to report" -- an ambiguous or
 * transient failure must never trigger a suspension write.
 */
async function detectAndRecordSuspension(
  tenantId: string,
  connectionId: string,
  page: MercariPage,
): Promise<void> {
  let content: string;
  try {
    content = await page.content();
  } catch {
    return;
  }

  const reason = classifyMercariSuspension(content);
  if (!reason) {
    return;
  }

  // scrubSecrets is effectively a no-op here (the reason string is built
  // entirely from a static pattern match, never from raw page content) --
  // called anyway so every recordSuspensionSignal call site in the
  // connector layer scrubs its reason the same way (see amazon.ts/
  // poshmark.ts).
  recordSuspensionSignal(tenantId, connectionId, scrubSecrets(reason, []), 'suspended');
}

/**
 * Builds the SessionHooks passed to every withSession/validateSessionReadOnly
 * call this file makes -- one choke point so validateSession/performLogin
 * behavior (and the suspension check riding along with validateSession)
 * stays identical across all 5 Connector methods.
 */
function buildMercariSessionHooks(tenantId: string, connectionId: string): SessionHooks {
  return {
    validateSession: async (page) => {
      const p = asPage(page);
      const authenticated = await isAuthenticatedMercariSession(p);
      // Suspension banner text can appear on an otherwise "authenticated"
      // page (nav chrome can still render for a restricted account), so
      // this check always runs, independent of the auth result above.
      await detectAndRecordSuspension(tenantId, connectionId, p);
      return authenticated;
    },
    performLogin: performMercariLogin,
  };
}

// ---------------------------------------------------------------------------
// Listing content helpers
// ---------------------------------------------------------------------------

function formatDollars(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

/** Builds the listing description text from category-specific details. */
function buildListingDescription(input: Pick<ListingInput, 'category' | 'details'>): string {
  if (input.category === 'book') {
    const d = input.details as BookDetails;
    return [
      d.author ? `By ${d.author}` : null,
      d.publisher ? `Publisher: ${d.publisher}` : null,
      d.isbn ? `ISBN: ${d.isbn}` : null,
      `Condition: ${d.condition}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = input.details as ClothingDetails;
  return [
    d.brand ? `Brand: ${d.brand}` : null,
    d.size_label ? `Size: ${d.size_label}` : null,
    d.color ? `Color: ${d.color}` : null,
    `Condition: ${d.condition}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Fills Mercari's category-specific fields (brand/size/color for clothing,
 * a "Books" category checkbox for books). Real Mercari category-picker
 * selectors are a multi-step dropdown/typeahead flow not modeled in detail
 * here -- documented as the maintainer's next step against a live account;
 * this best-effort version fills the fields the create-listing form is
 * known to expose as plain inputs.
 */
async function fillCategoryFields(page: MercariPage, input: ListingInput): Promise<void> {
  if (input.category === 'clothing') {
    const d = input.details as ClothingDetails;
    await page.fill('[data-testid="listing-brand-input"]', d.brand ?? '');
    await page.fill('[data-testid="listing-size-input"]', d.size_label ?? '');
    if (d.color) {
      await page.fill('[data-testid="listing-color-input"]', d.color);
    }
    return;
  }

  await page.check('[data-testid="listing-category-books"]');
}

/**
 * Uploads listing photos by VALUE (file paths handed to setInputFiles,
 * Playwright's own documented way of attaching files by path), never
 * through a dynamically-built selector.
 */
async function uploadListingPhotos(page: MercariPage, photos: ListingInput['photos']): Promise<void> {
  if (photos.length === 0) {
    return;
  }
  const paths = photos
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((photo) => photo.path);
  await page.setInputFiles('[data-testid="listing-photo-upload-input"]', paths);
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
async function isItemNotFound(page: MercariPage): Promise<boolean> {
  try {
    return await page.isVisible('[data-testid="item-not-found"]');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

async function createListingAction(page: MercariPage, input: ListingInput): Promise<CreateListingResult> {
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
  await page.fill('[data-testid="listing-price-input"]', formatDollars(input.priceCents));

  // 3. Category-specific fields (size/brand for clothing, category for
  //    books).
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
  page: MercariPage,
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
    await page.fill('[data-testid="listing-price-input"]', formatDollars(patch.priceCents));
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

async function markSoldAction(page: MercariPage, externalListingId: string): Promise<MarkSoldResult> {
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

async function delistAction(page: MercariPage, externalListingId: string): Promise<DelistResult> {
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
