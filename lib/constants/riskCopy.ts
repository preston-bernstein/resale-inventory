import { type SupportedPlatform, POSHMARK_RELIST_COOLDOWN_DAYS, POSHMARK_SHARE_CAP_PER_24H } from '@/lib/constants';

const oauthTierDefault = 'API-based access carries lower ban risk than credential-sharing automation.';

const credentialTierDefault = 'Credential-sharing automation carries ban risk. Rate limits are conservative and undocumented.';

const riskCopyMap: Record<SupportedPlatform, string> = {
  ebay: oauthTierDefault,
  etsy: oauthTierDefault,
  amazon: oauthTierDefault,
  poshmark: `Automated relisting triggers a ${POSHMARK_RELIST_COOLDOWN_DAYS}-day delist/relist cooldown. Share rate is capped at ${POSHMARK_SHARE_CAP_PER_24H} per 24h. Rate limits are enforced regardless of credential state.`,
  depop: credentialTierDefault,
  mercari: credentialTierDefault,
  vinted: credentialTierDefault,
  grailed: credentialTierDefault,
};

export function getRiskCopy(platform: SupportedPlatform): string {
  return riskCopyMap[platform];
}
