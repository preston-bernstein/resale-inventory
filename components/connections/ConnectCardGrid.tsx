'use client';

import { SUPPORTED_PLATFORMS, type SupportedPlatform } from '@/lib/constants';
import { platformTiers } from '@/lib/constants/platformTiers';
import type { ConnectionMetadata } from '@/lib/connections';
import ConnectCard from './ConnectCard';

interface ConnectCardGridProps {
  connections: ConnectionMetadata[];
  onSelectPlatform: (platform: SupportedPlatform) => void;
}

const OAUTH_PLATFORMS = SUPPORTED_PLATFORMS.filter((p) => platformTiers[p] === 'oauth');
const CREDENTIAL_PLATFORMS = SUPPORTED_PLATFORMS.filter((p) => platformTiers[p] === 'credential');

const GRID_CLASSNAME = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4';

export default function ConnectCardGrid({ connections, onSelectPlatform }: ConnectCardGridProps) {
  return (
    <div className="space-y-6" data-testid="connect-card-grid">
      <section>
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">OAuth</h3>
        <div className={GRID_CLASSNAME}>
          {OAUTH_PLATFORMS.map((platform) => (
            <ConnectCard
              key={platform}
              platform={platform}
              tier="oauth"
              connection={connections.find((c) => c.platform === platform)}
              onSelect={() => onSelectPlatform(platform)}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Credential</h3>
        <div className={GRID_CLASSNAME}>
          {CREDENTIAL_PLATFORMS.map((platform) => (
            <ConnectCard
              key={platform}
              platform={platform}
              tier="credential"
              connection={connections.find((c) => c.platform === platform)}
              onSelect={() => onSelectPlatform(platform)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
