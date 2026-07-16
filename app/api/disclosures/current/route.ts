import { NextResponse } from 'next/server';
import { getCurrentDisclosureVersion } from '@/lib/consent';

// Deliberately the one non-tenant-scoped route in this increment (plan.md's
// API contract): the disclosure document itself isn't tenant data, so this
// handler does NOT call requireTenant() -- no auth, no cookie required.

export async function GET() {
  try {
    const { version, content } = getCurrentDisclosureVersion();
    return NextResponse.json({ version, content });
  } catch (err) {
    console.error('GET /api/disclosures/current error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
