import type { BookDetails, ClothingDetails } from '@/lib/types';
import { recordSuspensionSignal } from '@/lib/connections';
import { apiFetch } from './apiFetch';
import { scrubSecrets } from './scrub';
import {
  AmazonNotConfiguredError,
  ConnectorPlatformError,
  type Connector,
  type ListingInput,
  type CreateListingResult,
  type UpdateListingResult,
  type MarkSoldResult,
  type DelistResult,
  type HealthResult,
} from './types';

// Amazon Selling Partner API (SP-API) connector -- RAW (ungated)
// implementation. Gating (consent/connection-status checks via
// lib/automationGate.ts) is applied by gate.ts/registry.ts wrapping this
// connector, not here -- see ebay.ts/etsy.ts for the same split.
//
// INERT BY DEFAULT (FR25): unlike eBay/Etsy's generic
// ConnectorNotConfiguredError, a missing Amazon app credential throws the
// dedicated AmazonNotConfiguredError subclass (types.ts's doc comment: SP-API
// requires a paid Professional Selling Plan plus a completed Developer
// Profile that only the human account owner can obtain -- categorically
// heavier than a missing API key). Every one of the 5 Connector methods
// below calls assertAmazonConfigured() as its literal first statement,
// before constructing any request -- there is no code path in this file
// that reaches apiFetch() without AMAZON_LWA_CLIENT_ID,
// AMAZON_LWA_CLIENT_SECRET, and AMAZON_SP_API_REFRESH_TOKEN all already
// having been confirmed present.
//
// No tenant has a real Amazon Professional Selling Plan + completed
// Developer Profile (unlike eBay's Sandbox or Etsy's live-draft account), so
// nothing in this file has ever been exercised against a live SP-API
// account. Request/response shapes below are a documented, best-effort
// approximation of the Listings Items API (2021-08-01) and the LWA token
// endpoint, based on public API documentation only, and exercised here
// exclusively via mocked HTTP in amazon.test.ts.
//
// Credential model: unlike ebay.ts/etsy.ts (a per-tenant OAuth credential
// stored via lib/connections.ts + apiCredential.ts's getFreshAccessToken()),
// Amazon's app config here is a single, env-level LWA client + refresh
// token (AMAZON_LWA_CLIENT_ID/AMAZON_LWA_CLIENT_SECRET/
// AMAZON_SP_API_REFRESH_TOKEN) -- there is no per-tenant Amazon
// authorization flow implemented in this increment. tenantId/connectionId
// are still threaded through every method below (required by the Connector
// interface, and needed to call recordSuspensionSignal against the right
// row), but they never affect which credential is used.

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const SP_API_BASE_URL = 'https://sellingpartnerapi-na.amazon.com';
const LISTINGS_API_VERSION = '2021-08-01';

// Amazon.com (US) marketplace -- the only marketplace this increment
// targets. Not configurable yet; a documented default, not a silent
// limitation (no gold-plating past what this task needs).
const DEFAULT_MARKETPLACE_ID = 'ATVPDKIKX0DER';

interface AmazonAppConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Amazon-specific "is this connector usable at all" gate -- checked as the
 * literal first statement of every one of the 5 Connector methods below,
 * before any request is constructed. Throws AmazonNotConfiguredError
 * directly (rather than requireEnv()'s generic ConnectorNotConfiguredError
 * caught-and-rethrown per var) so every call site stays a single, uniform
 * line, and so a caller doing `catch (e) { if (e instanceof
 * AmazonNotConfiguredError) ... }` never has to also handle the generic
 * base class arriving from this file.
 */
function assertAmazonConfigured(): AmazonAppConfig {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  if (!clientId) {
    throw new AmazonNotConfiguredError('AMAZON_LWA_CLIENT_ID');
  }
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  if (!clientSecret) {
    throw new AmazonNotConfiguredError('AMAZON_LWA_CLIENT_SECRET');
  }
  const refreshToken = process.env.AMAZON_SP_API_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new AmazonNotConfiguredError('AMAZON_SP_API_REFRESH_TOKEN');
  }
  return { clientId, clientSecret, refreshToken };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function safeStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SpApiErrorEntry {
  code?: string;
  message?: string;
}

/** SP-API error responses are shaped `{ errors: [{ code, message, details }] }`. */
function extractSpApiErrors(body: unknown): SpApiErrorEntry[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const errors = (body as Record<string, unknown>).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((e) => {
    const obj = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    return {
      code: typeof obj.code === 'string' ? obj.code : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Suspension classification (best-effort heuristic, req 12/13/18)
// ---------------------------------------------------------------------------
//
// Never verified against a real suspended/revoked Amazon seller account (no
// live account exists for this connector -- see file header). Conservative
// by design (req 13, "ambiguous errors are not suspension signals"): only a
// 403 whose SP-API error code/message positively suggests seller-account or
// API-access revocation is classified as suspension. A plain 401
// (expired/invalid access token -- normal, re-exchanged on the next call),
// 5xx, 429, and network timeouts are NEVER classified as suspension.

const SP_API_SUSPENSION_PATTERN =
  /account.*(suspend|deactivat|terminat|revok)|seller.*(suspend|deactivat|terminat)|api access.*(revok|terminat|disabl)/i;

function classifySpApiSuspensionReason(body: unknown): string | null {
  for (const err of extractSpApiErrors(body)) {
    const combined = `${err.code ?? ''} ${err.message ?? ''}`;
    if (SP_API_SUSPENSION_PATTERN.test(combined)) {
      return `amazon_403_${err.code ?? 'access_denied'}`;
    }
  }
  return null;
}

async function maybeRecordSpApiSuspension(
  tenantId: string,
  connectionId: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): Promise<void> {
  if (status !== 403) {
    // 401/5xx/429/timeout are never suspension signals -- see comment block
    // above.
    return;
  }
  const reason = classifySpApiSuspensionReason(body);
  if (!reason) {
    return;
  }
  recordSuspensionSignal(tenantId, connectionId, scrubSecrets(reason, secrets), 'suspended');
}

// req 18: an OAuth token-refresh failure is classified per the same rules --
// only when the LWA response positively indicates the refresh token/
// authorization was revoked (not merely an unspecified invalid_grant, which
// can also mean "expired" or "malformed", and never for a network/timeout/
// 5xx exchange failure).
const LWA_REVOCATION_PATTERN = /revok/i;

function classifyLwaRevocationReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const obj = body as Record<string, unknown>;
  const error = typeof obj.error === 'string' ? obj.error : '';
  const description = typeof obj.error_description === 'string' ? obj.error_description : '';

  if (error === 'unauthorized_client') {
    return 'amazon_lwa_unauthorized_client';
  }
  if (error === 'invalid_grant' && LWA_REVOCATION_PATTERN.test(description)) {
    return 'amazon_lwa_refresh_token_revoked';
  }
  return null;
}

async function maybeRecordLwaSuspension(
  tenantId: string,
  connectionId: string,
  status: number,
  body: unknown,
  secrets: (string | undefined | null)[],
): Promise<void> {
  // LWA reports invalid/revoked grants as 400 or 401 -- never treat a 5xx or
  // network failure as a candidate for revocation classification.
  if (status !== 400 && status !== 401 && status !== 403) {
    return;
  }
  const reason = classifyLwaRevocationReason(body);
  if (!reason) {
    return;
  }
  recordSuspensionSignal(tenantId, connectionId, scrubSecrets(reason, secrets), 'suspended');
}

// ---------------------------------------------------------------------------
// LWA (Login with Amazon) token exchange
// ---------------------------------------------------------------------------

interface LwaTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/**
 * Exchange the app-level refresh token for a fresh LWA access token via the
 * OAuth2 refresh_token grant. Not cached/reused across calls in this
 * increment (no per-connection token storage exists for Amazon -- see file
 * header); every one of the 5 Connector methods below re-exchanges on each
 * call, which is simple and correct even if not maximally efficient.
 */
async function exchangeLwaToken(
  config: AmazonAppConfig,
  tenantId: string,
  connectionId: string,
): Promise<string> {
  const secrets = [config.clientId, config.clientSecret, config.refreshToken];

  let result;
  try {
    result = await apiFetch(LWA_TOKEN_URL, {
      method: 'POST',
      body: {
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    // Network error/timeout surviving apiFetch's single retry -- transient,
    // never a suspension signal.
    throw new ConnectorPlatformError('amazon', 'lwa_network_error', scrubSecrets(errorMessage(err), secrets));
  }

  if (!result.ok) {
    await maybeRecordLwaSuspension(tenantId, connectionId, result.status, result.body, secrets);
    throw new ConnectorPlatformError(
      'amazon',
      `lwa_${result.status}`,
      scrubSecrets(
        `Amazon LWA token exchange failed with status ${result.status}: ${safeStringify(result.body)}`,
        secrets,
      ),
    );
  }

  const parsed = result.body as LwaTokenResponse;
  if (!parsed || typeof parsed.access_token !== 'string') {
    throw new ConnectorPlatformError(
      'amazon',
      'lwa_bad_response',
      'Amazon LWA token exchange returned an unexpected response shape',
    );
  }
  return parsed.access_token;
}

// ---------------------------------------------------------------------------
// SP-API Listings Items request plumbing
// ---------------------------------------------------------------------------

/**
 * Amazon requires a seller-defined SKU and the seller's own sellerId in
 * every Listings Items API path. There is no stored per-tenant Amazon
 * seller/merchant identifier anywhere in this codebase (no real
 * authorization flow -- see file header), so connectionId stands in as the
 * sellerId path segment here. Documented approximation, not a real
 * merchant-identity resolution.
 */
function listingsItemsUrl(connectionId: string, sku: string): string {
  const params = new URLSearchParams({ marketplaceIds: DEFAULT_MARKETPLACE_ID });
  return `${SP_API_BASE_URL}/listings/${LISTINGS_API_VERSION}/items/${encodeURIComponent(
    connectionId,
  )}/${encodeURIComponent(sku)}?${params.toString()}`;
}

async function callSpApi(
  method: string,
  url: string,
  accessToken: string,
  body: unknown,
  secrets: (string | undefined | null)[],
): Promise<{ status: number; ok: boolean; body: unknown }> {
  try {
    return await apiFetch(url, {
      method,
      headers: { 'x-amz-access-token': accessToken },
      body,
      timeoutMs: 10_000,
    });
  } catch (err) {
    throw new ConnectorPlatformError('amazon', 'sp_api_network_error', scrubSecrets(errorMessage(err), secrets));
  }
}

function isNotFoundResponse(status: number, body: unknown): boolean {
  if (status === 404) {
    return true;
  }
  return extractSpApiErrors(body).some((e) => e.code === 'NotFound');
}

/**
 * Shared response handling for updateListing/markSold/delist: a normal 2xx
 * is `{ok: true}`, a not-found-shaped response is the typed
 * `{ok: false, reason: 'not_found'}` result (per plan.md's documented
 * "not-found is a normal steady-state outcome, not an exception" decision),
 * and anything else runs suspension classification and throws
 * ConnectorPlatformError.
 */
async function sendListingsWrite(
  method: string,
  url: string,
  accessToken: string,
  body: unknown,
  secrets: (string | undefined | null)[],
  tenantId: string,
  connectionId: string,
  opCode: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const result = await callSpApi(method, url, accessToken, body, secrets);

  if (result.ok) {
    return { ok: true };
  }
  if (isNotFoundResponse(result.status, result.body)) {
    return { ok: false, reason: 'not_found' };
  }

  await maybeRecordSpApiSuspension(tenantId, connectionId, result.status, result.body, secrets);
  throw new ConnectorPlatformError(
    'amazon',
    `sp_api_${opCode}_${result.status}`,
    scrubSecrets(
      `Amazon SP-API ${opCode} failed with status ${result.status}: ${safeStringify(result.body)}`,
      secrets,
    ),
  );
}

// ---------------------------------------------------------------------------
// Listing payload construction
// ---------------------------------------------------------------------------

function mapCategoryToProductType(category: ListingInput['category']): string {
  return category === 'book' ? 'BOOKS' : 'CLOTHING';
}

function buildAttributeDescription(input: ListingInput): string {
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
 * PUT body shape for SP-API Listings Items (2021-08-01) createListing -- an
 * approximation of the real attribute schema (item_name/condition_type/
 * purchasable_offer), never validated against a live account. Amazon's real
 * per-productType attribute requirements (browse node, bullet points,
 * images, etc.) are out of scope here.
 */
function buildCreateListingBody(input: ListingInput): Record<string, unknown> {
  return {
    productType: mapCategoryToProductType(input.category),
    requirements: 'LISTING',
    attributes: {
      item_name: [{ value: input.title, marketplace_id: DEFAULT_MARKETPLACE_ID }],
      product_description: [
        { value: buildAttributeDescription(input), marketplace_id: DEFAULT_MARKETPLACE_ID },
      ],
      condition_type: [{ value: 'used_good', marketplace_id: DEFAULT_MARKETPLACE_ID }],
      purchasable_offer: [
        {
          marketplace_id: DEFAULT_MARKETPLACE_ID,
          currency: 'USD',
          our_price: [{ schedule: [{ value_with_tax: input.priceCents / 100 }] }],
        },
      ],
    },
  };
}

/**
 * PATCH body (JSON Patch-shaped, per SP-API's `patches` array convention)
 * for updateListing -- only includes ops for fields actually present on
 * `patch`. Note: SP-API's real PATCH schema also requires `productType` at
 * the top level; updateListing's Connector signature only receives a
 * title/price/details patch (no category), so productType can't be included
 * here without an extra lookup this increment doesn't implement --
 * documented approximation gap, not an oversight.
 */
function buildUpdateListingBody(
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Record<string, unknown> {
  const patches: Record<string, unknown>[] = [];

  if (patch.title !== undefined) {
    patches.push({
      op: 'replace',
      path: '/attributes/item_name',
      value: [{ value: patch.title, marketplace_id: DEFAULT_MARKETPLACE_ID }],
    });
  }
  if (patch.priceCents !== undefined) {
    patches.push({
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [
        {
          marketplace_id: DEFAULT_MARKETPLACE_ID,
          currency: 'USD',
          our_price: [{ schedule: [{ value_with_tax: patch.priceCents / 100 }] }],
        },
      ],
    });
  }
  if (patch.details !== undefined) {
    patches.push({
      op: 'replace',
      path: '/attributes/product_description',
      value: [{ value: safeStringify(patch.details), marketplace_id: DEFAULT_MARKETPLACE_ID }],
    });
  }

  return { patches };
}

/**
 * SP-API has no explicit "mark sold" concept for a self-fulfilled offer --
 * marking sold is approximated here as zeroing the offer's available
 * quantity via `fulfillment_availability`, the closest documented Listings
 * Items attribute for "no longer available for purchase." Documented
 * approximation, not a verified real API behavior.
 */
function buildMarkSoldBody(): Record<string, unknown> {
  return {
    patches: [
      {
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [{ marketplace_id: DEFAULT_MARKETPLACE_ID, quantity: 0 }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Connector methods
// ---------------------------------------------------------------------------

export async function createListing(input: ListingInput): Promise<CreateListingResult> {
  const config = assertAmazonConfigured();
  const accessToken = await exchangeLwaToken(config, input.tenantId, input.connectionId);
  const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken];

  const sku = input.itemId;
  const url = listingsItemsUrl(input.connectionId, sku);
  const result = await callSpApi('PUT', url, accessToken, buildCreateListingBody(input), secrets);

  if (!result.ok) {
    await maybeRecordSpApiSuspension(input.tenantId, input.connectionId, result.status, result.body, secrets);
    throw new ConnectorPlatformError(
      'amazon',
      `sp_api_create_${result.status}`,
      scrubSecrets(
        `Amazon SP-API createListing failed with status ${result.status}: ${safeStringify(result.body)}`,
        secrets,
      ),
    );
  }

  return { externalListingId: sku };
}

export async function updateListing(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
  patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
): Promise<UpdateListingResult> {
  const config = assertAmazonConfigured();
  const accessToken = await exchangeLwaToken(config, tenantId, connectionId);
  const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken];

  const url = listingsItemsUrl(connectionId, externalListingId);
  return sendListingsWrite(
    'PATCH',
    url,
    accessToken,
    buildUpdateListingBody(patch),
    secrets,
    tenantId,
    connectionId,
    'update',
  );
}

export async function markSold(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<MarkSoldResult> {
  const config = assertAmazonConfigured();
  const accessToken = await exchangeLwaToken(config, tenantId, connectionId);
  const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken];

  const url = listingsItemsUrl(connectionId, externalListingId);
  return sendListingsWrite(
    'PATCH',
    url,
    accessToken,
    buildMarkSoldBody(),
    secrets,
    tenantId,
    connectionId,
    'mark_sold',
  );
}

export async function delist(
  externalListingId: string,
  tenantId: string,
  connectionId: string,
): Promise<DelistResult> {
  const config = assertAmazonConfigured();
  const accessToken = await exchangeLwaToken(config, tenantId, connectionId);
  const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken];

  const url = listingsItemsUrl(connectionId, externalListingId);
  return sendListingsWrite('DELETE', url, accessToken, undefined, secrets, tenantId, connectionId, 'delist');
}

/**
 * Lightweight health probe -- attempts an LWA token exchange (the cheapest
 * available signal of "is this connection still authorized," since there is
 * no per-tenant participation/shop-info endpoint modeled for Amazon in this
 * increment). Only the not-configured guard throws (per the Connector
 * contract's requirement that AmazonNotConfiguredError surface before any
 * network call); any failure past that point (refresh failure, network
 * error, suspension) is reported as `{healthy: false, detail}` with detail
 * already scrubbed, mirroring etsy.ts's checkConnectionHealth convention so
 * a caller can always safely surface it without risking a credential leak.
 */
export async function checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult> {
  const config = assertAmazonConfigured();
  const secrets = [config.clientId, config.clientSecret, config.refreshToken];

  try {
    await exchangeLwaToken(config, tenantId, connectionId);
    return { healthy: true };
  } catch (err) {
    return {
      healthy: false,
      detail: scrubSecrets(errorMessage(err), secrets),
    };
  }
}

/**
 * Raw (ungated) Amazon Connector implementation -- wrap with
 * gate.ts#buildConnector('amazon', amazonConnector) before exposing to
 * callers.
 */
export const amazonConnector: Connector = {
  createListing,
  updateListing,
  markSold,
  delist,
  checkConnectionHealth,
};
