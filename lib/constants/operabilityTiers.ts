import { type SupportedPlatform } from '@/lib/constants';

export const operabilityTiers = {
  ebay: 'sandbox-tested',
  etsy: 'live-draft-only',
  amazon: 'inert-until-credentialed',
  poshmark: 'dry-run-until-credentialed',
  depop: 'dry-run-until-credentialed',
  mercari: 'dry-run-until-credentialed',
  vinted: 'dry-run-until-credentialed',
  grailed: 'dry-run-until-credentialed',
  swappa: 'dry-run-until-credentialed',
} as const satisfies Record<SupportedPlatform, 'sandbox-tested' | 'live-draft-only' | 'inert-until-credentialed' | 'dry-run-until-credentialed'>;
