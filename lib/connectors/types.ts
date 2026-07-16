import type { BookDetails, ClothingDetails, Photo } from '@/lib/types';

// Shared types for the marketplace connector layer. Every concrete
// connector (amazon.ts, ebay.ts, poshmark.ts, ...) implements the
// `Connector` interface below against this same input/result shape, so
// the gating/registry/scrub layers can treat all platforms uniformly.

export interface ListingInput {
  itemId: string;
  tenantId: string;
  connectionId: string;
  title: string;
  priceCents: number;
  category: 'book' | 'clothing';
  details: BookDetails | ClothingDetails;
  photos: Photo[];
}

export type NotFoundResult = { ok: false; reason: 'not_found' };

export type UpdateListingResult = { ok: true } | NotFoundResult;

export type MarkSoldResult = { ok: true } | NotFoundResult;

export type DelistResult = { ok: true } | NotFoundResult;

export interface CreateListingResult {
  externalListingId: string;
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}

export interface Connector {
  createListing(input: ListingInput): Promise<CreateListingResult>;

  updateListing(
    externalListingId: string,
    tenantId: string,
    connectionId: string,
    patch: Partial<Pick<ListingInput, 'title' | 'priceCents' | 'details'>>,
  ): Promise<UpdateListingResult>;

  markSold(
    externalListingId: string,
    tenantId: string,
    connectionId: string,
  ): Promise<MarkSoldResult>;

  delist(
    externalListingId: string,
    tenantId: string,
    connectionId: string,
  ): Promise<DelistResult>;

  checkConnectionHealth(tenantId: string, connectionId: string): Promise<HealthResult>;
}

/**
 * Base class for every error thrown by the connector layer. Subclasses set
 * `this.name = this.constructor.name` here (rather than repeating a string
 * literal in each subclass) so `instanceof` checks and stack traces both
 * show the concrete subclass name.
 */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when a connector call is blocked by the automation gate (FR-level
 * consent/connection-status checks) before ever reaching the platform.
 */
export class ConnectorGatingError extends ConnectorError {
  readonly kind: 'missing_consent' | 'connection_not_active';
  readonly connectionId: string;

  constructor(kind: 'missing_consent' | 'connection_not_active', connectionId: string) {
    super(`Connector call blocked: ${kind} for connection ${connectionId}`);
    this.kind = kind;
    this.connectionId = connectionId;
  }
}

/** Thrown by the registry when asked for a connector for an unknown platform. */
export class UnsupportedPlatformError extends ConnectorError {
  constructor(platform: string) {
    super(`Unsupported platform: ${platform}`);
  }
}

/** Thrown when a platform connector is missing required environment configuration. */
export class ConnectorNotConfiguredError extends ConnectorError {
  readonly platform: string;
  readonly missingVar: string;

  constructor(platform: string, missingVar: string) {
    super(`${platform} connector not configured: missing environment variable ${missingVar}`);
    this.platform = platform;
    this.missingVar = missingVar;
  }
}

/** Amazon-specific configuration error -- always reports platform 'amazon'. */
export class AmazonNotConfiguredError extends ConnectorNotConfiguredError {
  constructor(missingVar: string) {
    super('amazon', missingVar);
  }
}

/**
 * Thrown for a platform-reported error during a connector call. `message`
 * must already be scrubbed of secrets by the caller before being passed in
 * here -- scrubbing itself lives in lib/connectors/scrub.ts, not this class.
 */
export class ConnectorPlatformError extends ConnectorError {
  readonly platform: string;
  readonly code: string;

  constructor(platform: string, code: string, message: string) {
    super(`[${platform}] ${code}: ${message}`);
    this.platform = platform;
    this.code = code;
  }
}

/** Thrown when a Poshmark action is blocked by a relist cooldown or share cap. */
export class PoshmarkCooldownError extends ConnectorError {
  readonly kind: 'relist_cooldown' | 'share_cap';
  readonly connectionId: string;

  constructor(kind: 'relist_cooldown' | 'share_cap', connectionId: string) {
    super(`Poshmark call blocked: ${kind} for connection ${connectionId}`);
    this.kind = kind;
    this.connectionId = connectionId;
  }
}

/** Thrown when a platform rate-limits a connector call. */
export class ConnectorRateLimitedError extends ConnectorError {
  readonly platform: string;
  readonly connectionId: string;

  constructor(platform: string, connectionId: string) {
    super(`Rate limited by ${platform} for connection ${connectionId}`);
    this.platform = platform;
    this.connectionId = connectionId;
  }
}
