import { v4 as uuidv4 } from 'uuid';
import type { BookDetails, ClothingDetails } from '@/lib/types';
import { recordSuspensionSignal } from '@/lib/connections';
import { requireEnv } from './envConfig';
import { getFreshAccessToken } from './apiCredential';
import { apiFetch } from './apiFetch';
import { scrubSecrets } from './scrub';
import {
  ConnectorPlatformError,
  type Connector,
  type ListingInput,
  type CreateListingResult,
  type UpdateListingResult,
  type MarkSoldResult,
  type DelistResult,
  type HealthResult,
} from './types';

// eBay connector -- OAuth/client-setup portion (getEbayBaseUrl/ebayExchangeFn/
// getEbayAccessToken) plus the 5 raw Connector methods against eBay's Sell
// Inventory API (Sandbox only -- see getEbayBaseUrl). Gating (consent/
// connection-status checks via lib/automationGate.ts) is applied by
// gate.ts/registry.ts wrapping this connector, not here -- same split as
// etsy.ts.
//
// SAFETY-CRITICAL INVARIANT (same class as etsy.ts's draft-state invariant,
// but shaped differently here since eBay's Inventory API has no separate
// "draft" listing state to sit behind): every write in this file only ever
// targets EBAY_ENV=sandbox (enforced by getEbayBaseUrl() below, which throws
// rather than falling back to production) -- there is no live eBay account
// to validate this connector against, so nothing here should ever be
// pointed at eBay's production endpoints in this increment.
//
// eBay's Sell Inventory API flow for a fixed-price listing is multi-step
// (Create/Replace Inventory Item -> Create Offer -> Publish Offer), unlike
// Etsy's single-call listing create. That multi-step shape, plus the
// suspension-classification and not-found-mapping conventions, deliberately
// mirror etsy.ts for consistency across the 3 API-tier connectors -- see
// that file's header/comments for the shared reasoning not repeated here.

const EBAY_SANDBOX_BASE_URL = 'https://api.sandbox.ebay.com';

/**
 * Returns the base URL for eBay API calls. EBAY_ENV defaults to 'sandbox'
 * when unset -- this must never silently default to production. Production
 * support is not implemented in this increment; requesting a non-sandbox
 * env throws rather than pointing at a URL nobody has wired up (and
 * definitely never falls back to production silently).
 */
export function getEbayBaseUrl(): string {
  const env = process.env.EBAY_ENV ?? 'sandbox';
  if (env !== 'sandbox') {
    throw new Error(
      `EBAY_ENV=${env} is not supported yet -- only 'sandbox' is implemented in this increment`,
    );
  }
  return EBAY_SANDBOX_BASE_URL;
}

interface EbayOAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  token_type: string;
}

/**
 * Exchange a stored refresh token for a fresh eBay access token via the
 * OAuth2 refresh_token grant against eBay Sandbox's token endpoint, scoped
 * to sell.inventory. Signature matches what getFreshAccessToken() expects
 * for its exchangeFn parameter.
 */
export async function ebayExchangeFn(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}> {
  const clientId = requireEnv('ebay', 'EBAY_SANDBOX_CLIENT_ID');
  const clientSecret = requireEnv('ebay', 'EBAY_SANDBOX_CLIENT_SECRET');

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  // apiFetch always JSON-serializes `body` and sets Content-Type:
  // application/json (see apiFetch.ts) -- it has no raw/form-encoded body
  // mode. Real eBay OAuth2 token endpoints conventionally expect
  // application/x-www-form-urlencoded, but per this task's scope there are
  // no live sandbox creds to validate against yet and the unit test mocks
  // apiFetch entirely, so the grant parameters are sent as a JSON object
  // through apiFetch's existing (shared, not eBay-specific) contract rather
  // than hand-rolling a second body-encoding path here.
  const result = await apiFetch(`${EBAY_SANDBOX_BASE_URL}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
    },
    body: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    },
    timeoutMs: 10_000,
  });

  if (!result.ok) {
    throw new Error(
      `eBay OAuth token exchange failed with status ${result.status}: ${JSON.stringify(result.body)}`,
    );
  }

  const parsed = result.body as EbayOAuthTokenResponse;
  if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
    throw new Error('eBay OAuth token exchange returned an unexpected response shape');
  }

  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
    refreshToken: parsed.refresh_token,
  };
}

/**
 * Return a valid eBay access token for the given tenant/connection,
 * refreshing via ebayExchangeFn when the stored token is expired or
 * near-expiry.
 */
async function getEbayAccessToken(tenantId: string, connectionId: string): Promise<string> {
  return getFreshAccessToken(tenantId, connectionId, ebayExchangeFn);
}

// ---------------------------------------------------------------------------
// SKU generation
// ---------------------------------------------------------------------------

/**
 * eBay's Inventory Item is addressed by a seller-chosen SKU (PUT
 * .../inventory_item/{sku}), unlike Etsy where the platform assigns the
 * listing_id. Deriving the SKU from `input.itemId` alone would collide
 * across repeated test/dev runs against the same item (e.g. a retried
 * createListing call, or re-running an integration test against the same
 * fixture item) -- the same SKU would attempt to PUT-replace an
 * already-published Inventory Item every time. Appending a short random
 * suffix per call keeps each call's SKU unique (NFR: no cross-run
 * collisions) while still keeping the itemId visible in the SKU for
 * debuggability.
 */
function generateSku(itemId: string): string {
  return `${itemId}-${uuidv4().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Price conversion
// ---------------------------------------------------------------------------

/**
 * eBay's Offer API price fields (pricingSummary.price) are shaped
 * `{value: string, currency: string}` in major units -- unlike this app's
 * internal priceCents (minor units). USD is hardcoded as the only currency
 * this app deals in; there is no per-tenant/per-connection currency
 * preference anywhere else in the connector layer to read instead.
 */
function toEbayPrice(priceCents: number): { value: string; currency: string } {
  return {
    value: (priceCents / 100).toFixed(2),
    currency: 'USD',
  };
}

// ---------------------------------------------------------------------------
// Listing payload construction
// ---------------------------------------------------------------------------

function buildDescription(input: ListingInput): string {
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
 * Maps this app's free-text condition (BookCondition/ClothingCondition, see
 * lib/constants.ts) onto eBay's ConditionEnum. There is no verified,
 * live-account-confirmed mapping table for this -- best-effort only, same
 * caveat as the suspension-classification heuristic below. Falls back to
 * 'USED_GOOD' (the safest generic "used, functional" bucket) for anything
 * unrecognized rather than guessing wrong in either direction (NEW/e.g.
 * unsellable would misrepresent the item).
 */
function mapConditionToEbay(input: ListingInput): string {
  const condition = input.details.condition;
  if (condition === 'NWT') {
    return 'NEW';
  }
  return 'USED_GOOD';
}

/**
 * Builds the Create/Replace Inventory Item request body (step 1 of 3). Full
 * eBay-required-field mapping (itemSpecifics/aspects/packageWeightAndSize/
 * upc/etc.) is out of scope for this increment -- same "minimal viable
 * payload" scope call as etsy.ts's buildCreatePayload. Photo upload is also
 * out of scope: eBay's imageUrls must be publicly reachable URLs, and
 * lib/types.ts's Photo only carries a local `path`, not a public URL --
 * wiring that up needs a public asset-hosting story this increment doesn't
 * have (same class of gap as Etsy's photo omission).
 */
function buildInventoryItemPayload(input: ListingInput): Record<string, unknown> {
  return {
    availability: {
      shipToLocationAvailability: { quantity: 1 },
    },
    condition: mapConditionToEbay(input),
    product: {
      title: input.title,
      description: buildDescription(input),
    },
  };
}

// ---------------------------------------------------------------------------
// Suspension classification (best-effort heuristic)
// ---------------------------------------------------------------------------

// Real eBay error codes/messages for account/seller suspension aren't
// verifiable without a live suspended account (no sandbox account has ever
// been suspended to observe this against) -- this is a best-effort
// heuristic pending real API verification, same caveat as etsy.ts's
// isEtsySuspensionSignal. A plain 401 (expired/invalid token -- already
// handled by the OAuth refresh path) and any 5xx/429/timeout are NEVER
// classified as suspension.
const SUSPENSION_INDICATOR_PATTERNS = [
  'account is suspended',
  'account_suspended',
  'seller account is suspended',
  'seller account has been suspended',
  'not eligible to sell',
  'account is restricted',
  'account_restricted',
  'not eligible to list',
  'selling privileges',
  'selling_privileges_revoked',
];

function extractErrorText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.errors)) {
      return obj.errors
        .map((e) => {
          if (!e || typeof e !== 'object') return '';
          const err = e as Record<string, unknown>;
          return [err.errorId, err.domain, err.category, err.message, err.longMessage]
            .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
            .join(' ');
        })
        .join(' ');
    }
    return [obj.error, obj.error_description, obj.message]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return '';
}

/**
 * Best-effort classification of an eBay error response as an
 * account/seller-suspension signal. See SUSPENSION_INDICATOR_PATTERNS
 * comment above -- this heuristic is not verified against a real suspended
 * eBay account and should be tightened once real API behavior is known.
 */
export function isEbaySuspensionSignal(status: number, body: unknown): boolean {
  if (status !== 403) {
    // 401 = likely just an expired/invalid token (handled by refresh path);
    // 5xx/429/timeout = transient, never a suspension signal.
    return false;
  }
  const text = extractErrorText(body).toLowerCase();
  return SUSPENSION_INDICATOR_PATTERNS.some((pattern) => text.includes(pattern));
}

function classifySuspensionReason(body: unknown): string {
  const text = extractErrorText(body).toLowerCase();
  if (text.includes('restrict')) return 'ebay_403_account_restricted';
  if (text.includes('suspend')) return 'ebay_403_account_suspended';
  if (text.includes('eligible')) return 'ebay_403_seller_ineligible';
  return 'ebay_403_suspected_suspension';
}

async function maybeRecordSuspension(
  tenantId: string,
  connectionId: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): Promise<void> {
  if (!isEbaySuspensionSignal(status, body)) {
    return;
  }
  const reason = scrubSecrets(classifySuspensionReason(body), secrets);
  recordSuspensionSignal(tenantId, connectionId, reason, 'suspended');
}

// ---------------------------------------------------------------------------
// Error / not-found helpers
// ---------------------------------------------------------------------------

function safeStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function isNotFoundResponse(status: number, body: unknown): boolean {
  if (status === 404) {
    return true;
  }
  const text = extractErrorText(body).toLowerCase();
  return (
    text.includes('not found') ||
    text.includes('does not exist') ||
    text.includes('invalid sku') ||
    text.includes('invalid offer')
  );
}

function platformError(
  code: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): ConnectorPlatformError {
  const raw = `eBay request failed with status ${status}: ${safeStringify(body)}`;
  return new ConnectorPlatformError('ebay', code, scrubSecrets(raw, secrets));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

interface EbayOfferResponse {
  offerId?: string;
}

interface EbayPublishOfferResponse {
  listingId?: string;
  offerId?: string;
}

/**
 * Create a listing via eBay's 3-step Sell Inventory API flow: (1)
 * Create/Replace Inventory Item, (2) Create Offer referencing that
 * Inventory Item's SKU, (3) Publish the Offer. Each step's failure is
 * surfaced as a distinct error code (`inventory_item_*` / `offer_*` /
 * `publish_*`) so a caller/log can tell which step failed without parsing
 * the message body.
 *
 * `externalListingId` returned on success is the Offer's offerId (captured
 * from step 2's Create Offer response, and confirmed live only once step
 * 3's Publish call succeeds) -- NOT eBay's own public listingId. eBay's
 * Sell Inventory API addresses every subsequent per-listing operation
 * (update/withdraw) by offerId, not by the public listingId, so using the
 * offerId here is what makes updateListing/markSold/delist below directly
 * implementable against the externalListingId this method hands back --
 * the same design eBay's own API steers callers toward. This is within the
 * task's explicitly allowed range ("the eBay listingId or offerId returned
 * by publish").
 */
export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  const baseUrl = getEbayBaseUrl();
  const accessToken = await getEbayAccessToken(input.tenantId, input.connectionId);
  const sku = generateSku(input.itemId);

  // Step 1: Create/Replace Inventory Item.
  const inventoryItemResult = await apiFetch(`${baseUrl}/sell/inventory/v1/inventory_item/${sku}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Language': 'en-US',
    },
    body: buildInventoryItemPayload(input),
  });

  if (!inventoryItemResult.ok) {
    await maybeRecordSuspension(
      input.tenantId,
      input.connectionId,
      inventoryItemResult.status,
      inventoryItemResult.body,
      [accessToken],
    );
    throw platformError(
      `inventory_item_${inventoryItemResult.status}`,
      inventoryItemResult.status,
      inventoryItemResult.body,
      [accessToken],
    );
  }

  // Step 2: Create Offer referencing the SKU.
  const offerResult = await apiFetch(`${baseUrl}/sell/inventory/v1/offer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Language': 'en-US',
    },
    body: {
      sku,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      listingDescription: buildDescription(input),
      pricingSummary: {
        price: toEbayPrice(input.priceCents),
      },
    },
  });

  if (!offerResult.ok) {
    await maybeRecordSuspension(input.tenantId, input.connectionId, offerResult.status, offerResult.body, [
      accessToken,
    ]);
    throw platformError(`offer_${offerResult.status}`, offerResult.status, offerResult.body, [accessToken]);
  }

  const offerParsed = offerResult.body as EbayOfferResponse;
  if (!offerParsed?.offerId) {
    throw new ConnectorPlatformError(
      'ebay',
      'offer_bad_response',
      'eBay create-offer response did not include an offerId',
    );
  }
  const offerId = offerParsed.offerId;

  // Step 3: Publish the Offer -- this is what actually makes the listing
  // live/visible.
  const publishResult = await apiFetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Language': 'en-US',
    },
  });

  if (!publishResult.ok) {
    await maybeRecordSuspension(
      input.tenantId,
      input.connectionId,
      publishResult.status,
      publishResult.body,
      [accessToken],
    );
    throw platformError(`publish_${publishResult.status}`, publishResult.status, publishResult.body, [
      accessToken,
    ]);
  }

  // Confirm the publish response is at least shaped like a successful
  // publish before handing back the offerId as externalListingId -- an
  // ok:true response with a missing listingId would mean eBay silently
  // didn't actually publish anything, which should fail loudly rather than
  // return a listing id that isn't really live.
  const publishParsed = publishResult.body as EbayPublishOfferResponse;
  if (!publishParsed?.listingId) {
    throw new ConnectorPlatformError(
      'ebay',
      'publish_bad_response',
      'eBay publish-offer response did not include a listingId',
    );
  }

  return { externalListingId: offerId };
}

/**
 * Updates a listing by replacing its Inventory Item / Offer fields.
 * `externalListingId` is the offerId (see createListing's doc comment).
 * Since the Offer alone doesn't carry title/details -- those live on the
 * Inventory Item, addressed by SKU, not offerId -- this first does a GET on
 * the Offer to resolve its sku (and existing price, needed because eBay's
 * Offer PUT replaces the whole resource, not just the changed fields).
 * Maps a 404/"resource not found" eBay error (at any step) to
 * {ok:false, reason:'not_found'} rather than throwing.
 */
export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  const baseUrl = getEbayBaseUrl();
  const accessToken = await getEbayAccessToken(tenantId, connectionId);
  const offerId = externalListingId;

  const getOfferResult = await apiFetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!getOfferResult.ok) {
    if (isNotFoundResponse(getOfferResult.status, getOfferResult.body)) {
      return { ok: false, reason: 'not_found' };
    }
    await maybeRecordSuspension(tenantId, connectionId, getOfferResult.status, getOfferResult.body, [
      accessToken,
    ]);
    throw platformError(`offer_get_${getOfferResult.status}`, getOfferResult.status, getOfferResult.body, [
      accessToken,
    ]);
  }

  const existingOffer = getOfferResult.body as { sku?: string; listingDescription?: string };
  const sku = existingOffer?.sku;

  if ((patch.title !== undefined || patch.details !== undefined) && sku) {
    const inventoryPatchBody: Record<string, unknown> = {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: patch.details
        ? mapConditionToEbay({ details: patch.details } as ListingInput)
        : undefined,
      product: {
        title: patch.title,
      },
    };
    const inventoryResult = await apiFetch(`${baseUrl}/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Language': 'en-US' },
      body: inventoryPatchBody,
    });

    if (!inventoryResult.ok) {
      if (isNotFoundResponse(inventoryResult.status, inventoryResult.body)) {
        return { ok: false, reason: 'not_found' };
      }
      await maybeRecordSuspension(tenantId, connectionId, inventoryResult.status, inventoryResult.body, [
        accessToken,
      ]);
      throw platformError(
        `inventory_item_update_${inventoryResult.status}`,
        inventoryResult.status,
        inventoryResult.body,
        [accessToken],
      );
    }
  }

  if (patch.priceCents !== undefined) {
    const offerUpdateBody: Record<string, unknown> = {
      ...(sku ? { sku } : {}),
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      listingDescription: existingOffer?.listingDescription,
      pricingSummary: { price: toEbayPrice(patch.priceCents) },
    };
    const offerUpdateResult = await apiFetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Language': 'en-US' },
      body: offerUpdateBody,
    });

    if (!offerUpdateResult.ok) {
      if (isNotFoundResponse(offerUpdateResult.status, offerUpdateResult.body)) {
        return { ok: false, reason: 'not_found' };
      }
      await maybeRecordSuspension(
        tenantId,
        connectionId,
        offerUpdateResult.status,
        offerUpdateResult.body,
        [accessToken],
      );
      throw platformError(
        `offer_update_${offerUpdateResult.status}`,
        offerUpdateResult.status,
        offerUpdateResult.body,
        [accessToken],
      );
    }
  }

  return { ok: true };
}

/**
 * Shared implementation for markSold/delist: both end the live Offer via
 * eBay's withdraw operation, differing only in the reason code and the
 * error-code prefix used if it fails. eBay's documented EndReasonCodeType
 * enum (Trading API) has no literal "sold" value -- 'NOT_AVAILABLE' is the
 * closest documented reason meaning "no longer available for purchase",
 * which is what both a sale and a manual delist amount to from the Offer's
 * perspective. This is a best-effort choice (no live account to verify
 * eBay's REST Inventory API withdraw endpoint's actual accepted reason
 * values against) -- same caveat class as the suspension heuristic above.
 */
async function withdrawOffer(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  reason: string,
  opCode: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const baseUrl = getEbayBaseUrl();
  const accessToken = await getEbayAccessToken(tenantId, connectionId);
  const offerId = externalListingId;

  const result = await apiFetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}/withdraw`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Language': 'en-US' },
    body: { reason },
  });

  if (result.ok) {
    return { ok: true };
  }

  if (isNotFoundResponse(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }

  await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [accessToken]);
  throw platformError(`${opCode}_${result.status}`, result.status, result.body, [accessToken]);
}

export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  return withdrawOffer(externalListingId, tenantId, connectionId, 'NOT_AVAILABLE', 'mark_sold');
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  return withdrawOffer(externalListingId, tenantId, connectionId, 'NOT_AVAILABLE', 'delist');
}

/**
 * Lightweight authenticated health probe -- lists up to 1 Inventory Item.
 * Never throws: any failure (missing config, refresh failure, network
 * error, non-2xx response) is reported as `{ healthy: false, detail }` with
 * `detail` scrubbed of credential material, so a caller can safely surface
 * it (e.g. to decide whether to prompt for reconnect) without risking a
 * leak.
 */
export async function checkConnectionHealth(
  tenantId: string,
  connectionId: string,
): Promise<HealthResult> {
  let accessToken: string | undefined;

  try {
    const baseUrl = getEbayBaseUrl();
    accessToken = await getEbayAccessToken(tenantId, connectionId);

    const result = await apiFetch(`${baseUrl}/sell/inventory/v1/inventory_item?limit=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!result.ok) {
      await maybeRecordSuspension(tenantId, connectionId, result.status, result.body, [accessToken]);
      return {
        healthy: false,
        detail: scrubSecrets(`eBay health check failed with status ${result.status}`, [accessToken]),
      };
    }

    return { healthy: true };
  } catch (err) {
    return {
      healthy: false,
      detail: scrubSecrets(errorMessage(err), [accessToken]),
    };
  }
}

/** Raw (ungated) eBay Connector implementation -- wrap with gate.ts#buildConnector('ebay', ebayConnector) before exposing to callers. */
export const ebayConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
