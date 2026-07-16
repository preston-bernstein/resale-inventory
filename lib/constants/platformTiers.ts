import { type SupportedPlatform } from '@/lib/constants';

export const platformTiers = {
  ebay: 'oauth',
  etsy: 'oauth',
  amazon: 'oauth',
  poshmark: 'credential',
  depop: 'credential',
  mercari: 'credential',
  vinted: 'credential',
  grailed: 'credential',
} as const satisfies Record<SupportedPlatform, 'oauth' | 'credential'>;

export type PlatformTier = (typeof platformTiers)[keyof typeof platformTiers];
