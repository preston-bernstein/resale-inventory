import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireTenant } from '@/lib/apiRequest';

// Autocomplete data source for the add-item forms. Every value returned here
// comes from the operator's own past entries — no external service, no new
// infrastructure. Frequency-sorted (most-used first) since a value the
// operator has typed 10 times is more likely to be what they want next than
// one they typed once, then alphabetical as a tiebreaker for readability.

const CLOTHING_FIELDS = new Set(['brand', 'color', 'material', 'gender_department']);
const BOOK_FIELDS = new Set(['author', 'publisher']);
const MAX_SUGGESTIONS = 50;

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const { searchParams } = new URL(request.url);
    const field = searchParams.get('field');
    const brand = searchParams.get('brand'); // scopes `size_label` suggestions to one brand

    if (field === 'size_label') {
      if (!brand || !brand.trim()) {
        return NextResponse.json({ values: [] });
      }
      const rows = db
        .prepare(
          `SELECT size_label, COUNT(*) as n
             FROM clothing_details
            WHERE tenant_id = ? AND brand = ? AND size_label IS NOT NULL AND size_label != ''
            GROUP BY size_label
            ORDER BY n DESC, size_label ASC
            LIMIT ?`,
        )
        .all(tenant.tenantId, brand, MAX_SUGGESTIONS) as Array<{ size_label: string }>;
      return NextResponse.json({ values: rows.map(r => r.size_label) });
    }

    if (field && CLOTHING_FIELDS.has(field)) {
      const rows = db
        .prepare(
          `SELECT ${field} as value, COUNT(*) as n
             FROM clothing_details
            WHERE tenant_id = ? AND ${field} IS NOT NULL AND ${field} != ''
            GROUP BY ${field}
            ORDER BY n DESC, value ASC
            LIMIT ?`,
        )
        .all(tenant.tenantId, MAX_SUGGESTIONS) as Array<{ value: string }>;
      return NextResponse.json({ values: rows.map(r => r.value) });
    }

    if (field && BOOK_FIELDS.has(field)) {
      const rows = db
        .prepare(
          `SELECT ${field} as value, COUNT(*) as n
             FROM book_details
            WHERE tenant_id = ? AND ${field} IS NOT NULL AND ${field} != ''
            GROUP BY ${field}
            ORDER BY n DESC, value ASC
            LIMIT ?`,
        )
        .all(tenant.tenantId, MAX_SUGGESTIONS) as Array<{ value: string }>;
      return NextResponse.json({ values: rows.map(r => r.value) });
    }

    return NextResponse.json(
      { error: 'Unknown or missing field. Valid: brand, color, material, gender_department, size_label (with brand), author, publisher.' },
      { status: 400 },
    );
  } catch (err) {
    console.error('GET /api/items/suggestions error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
