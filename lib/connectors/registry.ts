import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '@/lib/constants';
import { buildConnector } from '@/lib/connectors/gate';
import type { Connector } from '@/lib/connectors/types';
import { UnsupportedPlatformError } from '@/lib/connectors/types';
import { ebayConnector } from '@/lib/connectors/ebay';
import { etsyConnector } from '@/lib/connectors/etsy';
import { amazonConnector } from '@/lib/connectors/amazon';
import { poshmarkConnector } from '@/lib/connectors/poshmark';
import { depopConnector } from '@/lib/connectors/depop';
import { mercariConnector } from '@/lib/connectors/mercari';
import { vintedConnector } from '@/lib/connectors/vinted';
import { grailedConnector } from '@/lib/connectors/grailed';

// The single lookup point from a platform string to a fully gated Connector.
// Every entry here is wrapped through gate.ts#buildConnector -- callers never
// get a raw, ungated platform connector out of this module. `satisfies
// Record<SupportedPlatform, Connector>` is load-bearing: it's a compile-time
// error if a platform from lib/constants.ts#SUPPORTED_PLATFORMS is missing
// below, or if any raw connector's shape doesn't actually satisfy the
// Connector interface once wrapped.
const CONNECTORS = {
  ebay: buildConnector('ebay', ebayConnector),
  etsy: buildConnector('etsy', etsyConnector),
  amazon: buildConnector('amazon', amazonConnector),
  poshmark: buildConnector('poshmark', poshmarkConnector),
  depop: buildConnector('depop', depopConnector),
  mercari: buildConnector('mercari', mercariConnector),
  vinted: buildConnector('vinted', vintedConnector),
  grailed: buildConnector('grailed', grailedConnector),
} satisfies Record<SupportedPlatform, Connector>;

/**
 * Look up the gated Connector for a platform string. Throws
 * UnsupportedPlatformError for anything outside
 * lib/constants.ts#SUPPORTED_PLATFORMS -- this is the only thing standing
 * between a garbage platform string and the connector layer, mirroring the
 * app-layer allowlist note on SUPPORTED_PLATFORMS itself.
 */
export function getConnector(platform: string): Connector {
  if (!SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
    throw new UnsupportedPlatformError(platform);
  }
  return CONNECTORS[platform as SupportedPlatform];
}
