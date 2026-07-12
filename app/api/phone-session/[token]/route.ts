import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { resolveToken, markFirstAccessed } from '@/lib/pairingToken';

// Same generic message for every failure case (not found, malformed,
// expired, ended, or item missing) — the response must never let a caller
// distinguish why resolution failed.
const INVALID_LINK_RESPONSE = { error: 'This link is no longer valid.' } as const;

interface ItemIdentifyingRow {
  id: string;
  title: string;
  brand: string;
  size_label: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;

    const resolved = resolveToken(token);
    if (!resolved) {
      return NextResponse.json(INVALID_LINK_RESPONSE, { status: 404 });
    }

    markFirstAccessed(resolved.id);

    // brand/size_label live on the clothing satellite table, not items
    // itself — the token's item was already validated as clothing at
    // issuance time, so a plain join is safe here.
    const item = db
      .prepare(
        `SELECT items.id AS id, items.title AS title,
                clothing_details.brand AS brand, clothing_details.size_label AS size_label
         FROM items
         JOIN clothing_details ON clothing_details.item_id = items.id
         WHERE items.id = ?`,
      )
      .get(resolved.itemId) as ItemIdentifyingRow | undefined;

    if (!item) {
      // Defensive: FK is ON DELETE CASCADE, so this shouldn't be reachable,
      // but never leak a distinguishable response if it somehow happens.
      return NextResponse.json(INVALID_LINK_RESPONSE, { status: 404 });
    }

    return NextResponse.json({
      item: {
        id: item.id,
        title: item.title,
        brand: item.brand,
        size_label: item.size_label,
      },
      expires_at: resolved.expiresAt,
    });
  } catch (err) {
    console.error('GET /api/phone-session/[token] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
