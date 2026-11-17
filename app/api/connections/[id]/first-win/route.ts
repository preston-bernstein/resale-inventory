import type { NextRequest} from 'next/server';
import { NextResponse } from 'next/server';
import { withOwnedConnection } from '@/lib/apiRequest';
import { getConnector } from '@/lib/connectors/registry';
import { ConnectorNotConfiguredError } from '@/lib/connectors/types';
import db from '@/lib/db';

interface ConnectionHealth {
  healthy: boolean;
  detail: string | undefined;
}

async function probeConnectionHealth(
  tenantId: string,
  connection: { id: string; platform: string },
): Promise<ConnectionHealth> {
  try {
    const health = await getConnector(connection.platform).checkConnectionHealth(
      tenantId,
      connection.id,
    );
    return { healthy: health.healthy, detail: health.detail };
  } catch (err) {
    if (err instanceof ConnectorNotConfiguredError) {
      return { healthy: false, detail: 'connector not configured' };
    }
    console.error('GET /api/connections/[id]/first-win health check error:', err);
    return { healthy: false, detail: 'health check failed' };
  }
}

/** Unlisted items not yet listed on this platform. */
function countReadyItems(tenantId: string, platform: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS ready_count
       FROM items i
       WHERE i.tenant_id = ?
         AND i.status = 'Unlisted'
         AND NOT EXISTS (
           SELECT 1 FROM item_platforms ip
           WHERE ip.item_id = i.id AND ip.platform = ? AND ip.tenant_id = ?
         )`,
    )
    .get(tenantId, platform, tenantId) as { ready_count: number };
  return row.ready_count;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOwnedConnection(
    request,
    params,
    'GET /api/connections/[id]/first-win',
    async ({ tenantId, connection }) => {
      const { healthy, detail } = await probeConnectionHealth(tenantId, connection);

      return NextResponse.json({
        healthy,
        ...(detail !== undefined ? { detail } : {}),
        readyCount: countReadyItems(tenantId, connection.platform),
      });
    },
  );
}
