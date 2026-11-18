import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireTenant, parseJsonBody } from '@/lib/apiRequest';
import { handleBookCreate } from './_create/book';
import { handleClothingCreate } from './_create/clothing';
import { handleElectronicsCreate } from './_create/electronics';
import { validateCategory, validateSharedFields } from './_create/shared';
import { parseListQueryParams } from './_list/query';
import { searchItems } from './_list/rows';

// ---------------------------------------------------------------------------
// POST /api/items — create a book, clothing or electronics item. Each
// category's validate-then-insert-then-respond steps live in ./_create;
// POST() itself is just the sequencing + the outer try/catch → 500 safety net.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const parsed = await parseJsonBody(request);
    if ('error' in parsed) return parsed.error;
    const { body } = parsed;

    const categoryResult = validateCategory(body);
    if ('error' in categoryResult) return categoryResult.error;
    const cat = categoryResult.category;

    const shared = validateSharedFields(body, cat);

    // Exhaustive switch (not an if/return chain): a category ever added to
    // `Category` without a matching case here fails to compile at the
    // `_exhaustive: never` assignment below, instead of silently falling
    // through to whichever branch happened to be the `else`/final `return`.
    switch (cat) {
      case 'book':
        return await handleBookCreate(body, shared, tenant.tenantId);
      case 'clothing':
        return handleClothingCreate(body, shared, tenant.tenantId);
      case 'electronics':
        return handleElectronicsCreate(body, shared, tenant.tenantId);
      default: {
        const _exhaustive: never = cat;
        throw new Error(`Unknown category: ${_exhaustive}`);
      }
    }
  } catch (err) {
    console.error('POST /api/items error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/items — search across all categories (query building in ./_list).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    const { searchParams } = new URL(request.url);
    const parsed = parseListQueryParams(searchParams);
    if (parsed instanceof NextResponse) return parsed;

    const { items, total } = searchItems(tenant.tenantId, parsed);

    return NextResponse.json({ items, total, page: parsed.page, limit: parsed.limit });
  } catch (err) {
    console.error('GET /api/items error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
