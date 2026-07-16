import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedConnection } from '@/lib/apiRequest';
import { getConnector } from '@/lib/connectors/registry';
import { ConnectorNotConfiguredError } from '@/lib/connectors/types';
import db from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await resolveOwnedConnection(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, connection } = resolved;

    let healthy: boolean;
    let detail: string | undefined;

    try {
      const health = await getConnector(connection.platform).checkConnectionHealth(
        tenantId,
        connection.id,
      );
      healthy = health.healthy;
      detail = health.detail;
    } catch (err) {
      if (err instanceof ConnectorNotConfiguredError) {
        healthy = false;
        detail = 'connector not configured';
      } else {
        healthy = false;
        detail = 'health check failed';
      }
    }

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
      .get(tenantId, connection.platform, tenantId) as { ready_count: number };

    return NextResponse.json({
      healthy,
      ...(detail !== undefined ? { detail } : {}),
      readyCount: row.ready_count,
    });
  } catch (err) {
    console.error('GET /api/connections/[id]/first-win error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
