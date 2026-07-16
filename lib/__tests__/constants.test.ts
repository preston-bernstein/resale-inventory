import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_PLATFORMS,
  POSHMARK_RELIST_COOLDOWN_DAYS,
  POSHMARK_SHARE_CAP_PER_24H,
  DEPOP_ACTION_RATE_LIMIT_MS,
  MERCARI_ACTION_RATE_LIMIT_MS,
  VINTED_ACTION_RATE_LIMIT_MS,
  GRAILED_ACTION_RATE_LIMIT_MS,
  type SupportedPlatform,
} from '../constants';

describe('SUPPORTED_PLATFORMS', () => {
  it('contains all expected platforms', () => {
    expect(SUPPORTED_PLATFORMS).toContain('ebay');
    expect(SUPPORTED_PLATFORMS).toContain('etsy');
    expect(SUPPORTED_PLATFORMS).toContain('amazon');
    expect(SUPPORTED_PLATFORMS).toContain('poshmark');
    expect(SUPPORTED_PLATFORMS).toContain('depop');
    expect(SUPPORTED_PLATFORMS).toContain('mercari');
    expect(SUPPORTED_PLATFORMS).toContain('vinted');
    expect(SUPPORTED_PLATFORMS).toContain('grailed');
  });

  it('has exactly 8 platforms', () => {
    expect(SUPPORTED_PLATFORMS).toHaveLength(8);
  });
});

describe('SupportedPlatform type', () => {
  it('allows valid platform strings', () => {
    const platforms: SupportedPlatform[] = ['ebay', 'etsy', 'amazon', 'poshmark', 'depop', 'mercari', 'vinted', 'grailed'];
    expect(platforms).toHaveLength(8);
  });

  it('allows assignment from SUPPORTED_PLATFORMS entries', () => {
    const p: SupportedPlatform = SUPPORTED_PLATFORMS[0];
    expect(p).toBe('ebay');
  });
});

describe('Poshmark constants', () => {
  it('POSHMARK_RELIST_COOLDOWN_DAYS equals 60', () => {
    expect(POSHMARK_RELIST_COOLDOWN_DAYS).toBe(60);
  });

  it('POSHMARK_SHARE_CAP_PER_24H equals 3500', () => {
    expect(POSHMARK_SHARE_CAP_PER_24H).toBe(3500);
  });
});

describe('Rate limit constants', () => {
  it('DEPOP_ACTION_RATE_LIMIT_MS equals 10000', () => {
    expect(DEPOP_ACTION_RATE_LIMIT_MS).toBe(10_000);
  });

  it('MERCARI_ACTION_RATE_LIMIT_MS equals 10000', () => {
    expect(MERCARI_ACTION_RATE_LIMIT_MS).toBe(10_000);
  });

  it('VINTED_ACTION_RATE_LIMIT_MS equals 10000', () => {
    expect(VINTED_ACTION_RATE_LIMIT_MS).toBe(10_000);
  });

  it('GRAILED_ACTION_RATE_LIMIT_MS equals 10000', () => {
    expect(GRAILED_ACTION_RATE_LIMIT_MS).toBe(10_000);
  });
});
