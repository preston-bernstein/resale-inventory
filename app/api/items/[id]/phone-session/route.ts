import { NextRequest, NextResponse } from 'next/server';
import {
  createToken,
  endActiveToken,
  getSessionStatus,
  loadClothingItemOrThrow,
  ItemNotFoundError,
  ItemNotClothingError,
} from '@/lib/pairingToken';
import { resolveTailnetOrigin } from '@/lib/tailnetOrigin';
import { parseItemId } from '@/lib/apiRequest';
import db from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsed = await parseItemId(params);
    if (parsed instanceof NextResponse) return parsed;
    const { id } = parsed;

    try {
      loadClothingItemOrThrow(id);
    } catch (err) {
      if (err instanceof ItemNotFoundError) {
        return NextResponse.json({ error: 'Not found.' }, { status: 404 });
      }
      if (err instanceof ItemNotClothingError) {
        return NextResponse.json({ error: err.message }, { status: 422 });
      }
      throw err;
    }

    // Resolve the tailnet origin BEFORE issuing any token — if we can't
    // build a safe URL for it, no token should be created at all.
    const origin = resolveTailnetOrigin(request);
    if (origin === null) {
      return NextResponse.json(
        {
          error:
            'Cannot determine a tailnet origin; open this app via its Tailscale Serve URL (…ts.net) to use phone handoff.',
        },
        { status: 409 },
      );
    }

    // createToken internally ends any prior active token for this item and
    // inserts the new one inside a single transaction.
    const { token, expiresAt } = createToken(id);

    // The raw token appears ONLY in this response body — never logged.
    const url = `${origin}/phone/${token}`;

    return NextResponse.json({ url, expires_at: expiresAt }, { status: 201 });
  } catch (err) {
    console.error('POST /api/items/[id]/phone-session error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

interface PhotoRow {
  id: string;
  path: string;
  sort_order: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsed = await parseItemId(params);
    if (parsed instanceof NextResponse) return parsed;
    const { id } = parsed;

    // Intentionally permissive: unlike POST, this is read-only status
    // information, not a security-sensitive write — an item with no
    // phone-session history simply reports status 'none', no 404.
    const { status, expiresAt } = getSessionStatus(id);

    const photos = db
      .prepare('SELECT id, path, sort_order FROM item_photos WHERE item_id = ? ORDER BY sort_order')
      .all(id) as PhotoRow[];

    return NextResponse.json({ status, expires_at: expiresAt, photos }, { status: 200 });
  } catch (err) {
    console.error('GET /api/items/[id]/phone-session error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsed = await parseItemId(params);
    if (parsed instanceof NextResponse) return parsed;
    const { id } = parsed;

    // Idempotent by design: ending an already-ended (or never-started)
    // session is not an error — always 204, no body.
    endActiveToken(id);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('DELETE /api/items/[id]/phone-session error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
