import { describe, it, expect } from 'vitest';
import {
  ConnectorError,
  ConnectorGatingError,
  UnsupportedPlatformError,
  ConnectorNotConfiguredError,
  AmazonNotConfiguredError,
  ConnectorPlatformError,
  PoshmarkCooldownError,
  ConnectorRateLimitedError,
} from '../types';

describe('ConnectorError', () => {
  it('is an Error with name set to the concrete subclass', () => {
    const err = new ConnectorError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.name).toBe('ConnectorError');
    expect(err.message).toBe('boom');
  });
});

describe('ConnectorGatingError', () => {
  it('carries kind/connectionId and a descriptive message', () => {
    const err = new ConnectorGatingError('missing_consent', 'conn-1');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorGatingError);
    expect(err.name).toBe('ConnectorGatingError');
    expect(err.kind).toBe('missing_consent');
    expect(err.connectionId).toBe('conn-1');
    expect(err.message).toBe('Connector call blocked: missing_consent for connection conn-1');
  });

  it('supports the connection_not_active kind', () => {
    const err = new ConnectorGatingError('connection_not_active', 'conn-2');
    expect(err.kind).toBe('connection_not_active');
    expect(err.connectionId).toBe('conn-2');
  });
});

describe('UnsupportedPlatformError', () => {
  it('carries the platform in its message', () => {
    const err = new UnsupportedPlatformError('bogus-platform');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(UnsupportedPlatformError);
    expect(err.name).toBe('UnsupportedPlatformError');
    expect(err.message).toBe('Unsupported platform: bogus-platform');
  });
});

describe('ConnectorNotConfiguredError', () => {
  it('carries platform/missingVar and a descriptive message', () => {
    const err = new ConnectorNotConfiguredError('ebay', 'EBAY_CLIENT_ID');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorNotConfiguredError);
    expect(err.name).toBe('ConnectorNotConfiguredError');
    expect(err.platform).toBe('ebay');
    expect(err.missingVar).toBe('EBAY_CLIENT_ID');
    expect(err.message).toBe(
      'ebay connector not configured: missing environment variable EBAY_CLIENT_ID',
    );
  });
});

describe('AmazonNotConfiguredError', () => {
  it('is also a ConnectorNotConfiguredError, hardcoded to platform amazon', () => {
    const err = new AmazonNotConfiguredError('AMAZON_REFRESH_TOKEN');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorNotConfiguredError);
    expect(err).toBeInstanceOf(AmazonNotConfiguredError);
    expect(err.name).toBe('AmazonNotConfiguredError');
    expect(err.platform).toBe('amazon');
    expect(err.missingVar).toBe('AMAZON_REFRESH_TOKEN');
    expect(err.message).toBe(
      'amazon connector not configured: missing environment variable AMAZON_REFRESH_TOKEN',
    );
  });
});

describe('ConnectorPlatformError', () => {
  it('carries platform/code and formats the message as [platform] code: message', () => {
    const err = new ConnectorPlatformError('poshmark', 'AUTH_FAILED', 'invalid session');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorPlatformError);
    expect(err.name).toBe('ConnectorPlatformError');
    expect(err.platform).toBe('poshmark');
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).toBe('[poshmark] AUTH_FAILED: invalid session');
  });
});

describe('PoshmarkCooldownError', () => {
  it('carries kind/connectionId', () => {
    const err = new PoshmarkCooldownError('relist_cooldown', 'conn-3');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(PoshmarkCooldownError);
    expect(err.name).toBe('PoshmarkCooldownError');
    expect(err.kind).toBe('relist_cooldown');
    expect(err.connectionId).toBe('conn-3');
    expect(err.message).toBe('Poshmark call blocked: relist_cooldown for connection conn-3');
  });

  it('supports the share_cap kind', () => {
    const err = new PoshmarkCooldownError('share_cap', 'conn-4');
    expect(err.kind).toBe('share_cap');
    expect(err.connectionId).toBe('conn-4');
  });
});

describe('ConnectorRateLimitedError', () => {
  it('carries platform/connectionId', () => {
    const err = new ConnectorRateLimitedError('etsy', 'conn-5');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toBeInstanceOf(ConnectorRateLimitedError);
    expect(err.name).toBe('ConnectorRateLimitedError');
    expect(err.platform).toBe('etsy');
    expect(err.connectionId).toBe('conn-5');
    expect(err.message).toBe('Rate limited by etsy for connection conn-5');
  });
});
