import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { requireTenantAndParam, parseJsonBody } from '@/lib/apiRequest';
import {
  conditionsForCategory,
  platformsForCategory,
  SUPPORTED_PLATFORMS,
  type Category,
  type SupportedPlatform,
} from '@/lib/constants';
import {
  validateWeightOz,
  validateMeasurement,
  validateGenderDepartment,
  CLOTHING_MEASUREMENT_FIELDS,
} from '@/lib/clothing';
import {
  validateBatteryHealthPct,
  validateBatteryCycleCount,
  validateRamGb,
  validateStorageGb,
  validateScreenSizeIn,
} from '@/lib/electronics';

// Terminal statuses lock an item against any further PATCH edits — covers
// all 4, not just Sold, per book-inventory-management's existing behavior
// (ported verbatim from app/api/books/[id]/route.ts).
const TERMINAL = ['Sold', 'Removed', 'Donated', 'Discarded'];
const PRICE_REQUIRED = ['Listed', 'Sale Pending'];

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

// brand/model on electronics_details are TEXT NOT NULL (no separate
// canonical-brand table, unlike clothing's clothing_brands -- see plan.md's
// "Design decisions" on why laptop brand stays a plain column). PATCH must
// reject null/empty so it can never null out a NOT NULL column.
function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// Fetches the category-scoped detail row for an item, trimmed to exactly the
// fields defined on BookDetails / ClothingDetails / ElectronicsDetails in
// lib/types.ts (no leaking item_id back out in the response).
//
// Exhaustive switch (not an if/return chain): a missed category here must
// fail to compile via the `never` check below, not silently return the
// wrong satellite row for an unrecognized category.
function fetchDetails(id: string, category: Category): Record<string, unknown> {
  switch (category) {
    case 'book':
      return db
        .prepare('SELECT isbn, author, publisher, condition FROM book_details WHERE item_id = ?')
        .get(id) as Record<string, unknown>;
    case 'clothing':
      return db
        .prepare(
          `SELECT brand, size_label, color, material, gender_department, weight_oz,
                  pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in,
                  inseam_in, leg_opening_in, hip_in, condition
           FROM clothing_details WHERE item_id = ?`,
        )
        .get(id) as Record<string, unknown>;
    case 'electronics':
      return db
        .prepare(
          `SELECT device_type, brand, model, processor, ram_gb, storage_gb,
                  screen_size_in, battery_health_pct, battery_cycle_count, condition
           FROM electronics_details WHERE item_id = ?`,
        )
        .get(id) as Record<string, unknown>;
    default: {
      const _exhaustive: never = category;
      throw new Error(`Unknown category: ${_exhaustive}`);
    }
  }
}

function fetchPlatforms(id: string): string[] {
  const row = db
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(platform, ','), '') as platforms_csv
       FROM item_platforms WHERE item_id = ?`,
    )
    .get(id) as { platforms_csv: string };
  return row.platforms_csv ? row.platforms_csv.split(',') : [];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await requireTenantAndParam(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, id } = resolved;

    const item = db.prepare('SELECT * FROM items WHERE id = ? AND tenant_id = ?').get(
      id,
      tenantId,
    ) as Record<string, unknown> | undefined;
    if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    const category = item.category as Category;
    const details = fetchDetails(id, category);
    const platforms = fetchPlatforms(id);

    const priceHistory = db
      .prepare('SELECT * FROM price_history WHERE item_id = ? ORDER BY changed_at')
      .all(id) as Array<Record<string, unknown>>;

    // Always run this query — it naturally returns zero rows for a book
    // item, since photos are never inserted for books (FR14).
    const photos = db
      .prepare('SELECT id, path, sort_order FROM item_photos WHERE item_id = ? ORDER BY sort_order')
      .all(id) as Array<Record<string, unknown>>;

    return NextResponse.json({
      ...item,
      details,
      platforms,
      price_history: priceHistory,
      photos,
    });
  } catch (err) {
    console.error('GET /api/items/[id] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

// --- PATCH: field-level validation -----------------------------------------
//
// Each validator inspects one field of the PATCH body in isolation. Its
// `listing_price` outcome — early-returning a NextResponse — is special:
// clearing listing_price while the item is Listed/Sale Pending must
// short-circuit the whole request with its own specific 422, before any
// other field is even validated (this matches the original inline behavior
// exactly).
//
// Each validator below reports its outcome through two channels: a plain
// return value (the resolved field value, or `undefined` when absent or
// invalid), and a shared `invalidFields` array it pushes its own field name
// into on failure. Deliberately NOT wrapped in a tagged/discriminated
// object: a wrapper object here would be redundant (every caller already
// knows which field it asked about) and, in practice, worse — an
// object-literal wrapper around a value that a later step re-derives with
// `?? null` (see applyItemFieldUpdates) makes that wrapper invisible to
// mutation testing. Plain values, exactly like the original inline code,
// keep every branch directly observable.
function validateListingPrice(
  body: Record<string, unknown>,
  currentStatus: string,
  invalidFields: string[],
): NextResponse | number | null | undefined {
  if (!('listing_price' in body)) return undefined;

  const lp = body.listing_price;
  if (lp === null) {
    if (PRICE_REQUIRED.includes(currentStatus)) {
      return NextResponse.json(
        {
          error:
            'Cannot clear listing_price while status is Listed or Sale Pending. Transition the item first.',
        },
        { status: 422 },
      );
    }
    return null; // allow clearing to null
  }
  if (typeof lp !== 'number' || !Number.isInteger(lp) || lp < 0 || lp > 100_000_000) {
    invalidFields.push('listing_price');
    return undefined;
  }
  return lp;
}

// Beyond the Array<string> shape check, any submitted platform that IS one
// of the recognized SUPPORTED_PLATFORMS (the connector-automation set) must
// also be one of the platforms supported for this item's category (per
// PLATFORM_CATEGORY_SUPPORT in lib/constants.ts) -- this is what makes
// AC15/16 (electronics-only Swappa, book/clothing never see Swappa) an
// actual server-side rejection rather than only a UI-picker restriction.
// Platform strings OUTSIDE that recognized set (e.g. "AbeBooks", or a
// user's own free-text label) are untouched by this check and pass through
// exactly as before -- this field has always doubled as free-text manual
// listing-location tracking, not exclusively the automated connector list,
// and category-gating must not silently break that pre-existing use.
function validatePlatforms(
  body: Record<string, unknown>,
  category: Category,
  invalidFields: string[],
): string[] | undefined {
  if (!('platforms' in body)) return undefined;
  if (
    !Array.isArray(body.platforms) ||
    !(body.platforms as unknown[]).every((p) => typeof p === 'string')
  ) {
    invalidFields.push('platforms');
    return undefined;
  }
  const platforms = body.platforms as string[];
  const allowed = platformsForCategory(category) as readonly string[];
  const hasDisallowedKnownPlatform = platforms.some(
    (p) => SUPPORTED_PLATFORMS.includes(p as SupportedPlatform) && !allowed.includes(p),
  );
  if (hasDisallowedKnownPlatform) {
    invalidFields.push('platforms');
    return undefined;
  }
  return platforms;
}

function validateCondition(
  body: Record<string, unknown>,
  category: Category,
  invalidFields: string[],
): string | undefined {
  if (!('condition' in body)) return undefined;
  const c = body.condition;
  const vocab = conditionsForCategory(category);
  if (typeof c !== 'string' || !vocab.includes(c)) {
    invalidFields.push('condition');
    return undefined;
  }
  return c;
}

// Per-field validators for the clothing-only satellite fields, built once at
// module load via plain pushes (not `.map`, whose callback is itself a
// mutation target that can quietly go missing behind `Object.fromEntries`).
// Iterated by validateClothingUpdates below via one small loop instead of
// one hand-repeated if-block per field.
const CLOTHING_FIELD_VALIDATORS: Array<[string, (v: unknown) => boolean]> = [
  ['color', isNullableString],
  ['material', isNullableString],
  ['gender_department', validateGenderDepartment],
  ['weight_oz', validateWeightOz],
];
for (const field of CLOTHING_MEASUREMENT_FIELDS) {
  CLOTHING_FIELD_VALIDATORS.push([field, validateMeasurement]);
}

// Explicit allowlist (via CLOTHING_FIELD_VALIDATORS), only consulted when
// category === 'clothing'. For a book item these keys are never read, never
// validated, and never written — silently ignored, same treatment as
// `category` itself. `color`/`material` accept exactly null or a string
// (isNullableString), so `body[field] ?? null` reproduces the original
// direct assignment for both.
function validateClothingUpdates(
  body: Record<string, unknown>,
  category: Category,
  invalidFields: string[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (category !== 'clothing') return updates;

  for (const [field, validate] of CLOTHING_FIELD_VALIDATORS) {
    if (!(field in body)) continue;
    if (!validate(body[field])) invalidFields.push(field);
    else updates[field] = body[field] ?? null;
  }
  return updates;
}

// Per-field validators for the electronics-only satellite fields, mirroring
// CLOTHING_FIELD_VALIDATORS's shape exactly. Per FR13, the electronics PATCH
// allowlist is every electronics_details column except device_type (fixed
// 'laptop' for this increment) -- not just the battery fields. `condition`
// is deliberately NOT one of these tuples: it's already validated generically
// by validateCondition()/conditionsForCategory() above (which already
// returns ELECTRONICS_CONDITIONS for category === 'electronics') and applied
// via the shared `newCondition` path in applyDetailUpdates -- adding a
// second 'condition' tuple here would double-validate it and emit a second
// `condition = ?` SET clause.
const ELECTRONICS_FIELD_VALIDATORS: Array<[string, (v: unknown) => boolean]> = [
  ['brand', isNonEmptyString],
  ['model', isNonEmptyString],
  ['processor', isNullableString],
  ['ram_gb', validateRamGb],
  ['storage_gb', validateStorageGb],
  ['screen_size_in', validateScreenSizeIn],
  ['battery_health_pct', validateBatteryHealthPct],
  ['battery_cycle_count', validateBatteryCycleCount],
];

// Explicit allowlist (via ELECTRONICS_FIELD_VALIDATORS), only consulted when
// category === 'electronics'. For a book/clothing item these keys are never
// read, never validated, and never written — silently ignored, same
// treatment CLOTHING_FIELD_VALIDATORS gets for non-clothing items today.
function validateElectronicsUpdates(
  body: Record<string, unknown>,
  category: Category,
  invalidFields: string[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (category !== 'electronics') return updates;

  for (const [field, validate] of ELECTRONICS_FIELD_VALIDATORS) {
    if (!(field in body)) continue;
    if (!validate(body[field])) invalidFields.push(field);
    else updates[field] = body[field] ?? null;
  }
  return updates;
}

interface PatchValidationResult {
  // undefined = 'listing_price' not in body, don't touch it; null = clear
  // it; number = the validated new price. Resolved once here so the write
  // step can read it directly instead of re-inspecting `body`.
  resolvedListingPrice: number | null | undefined;
  newCondition: string | undefined;
  newPlatforms: string[] | undefined;
  clothingUpdates: Record<string, unknown>;
  electronicsUpdates: Record<string, unknown>;
}

// Runs all per-field PATCH validations, appending every problem found to
// `invalidFields` (every field is always validated, regardless of whether
// an earlier one was invalid, so the final list reflects every problem in
// the request — not just the first). The lone exception is listing_price's
// "blocked" case, which returns its own NextResponse immediately: clearing
// listing_price while Listed/Sale Pending must short-circuit the whole
// request with its specific 422, before any other field is even looked at
// (matching the original inline behavior exactly).
function validatePatchBody(
  body: Record<string, unknown>,
  current: Record<string, unknown>,
  category: Category,
  invalidFields: string[],
): NextResponse | PatchValidationResult {
  const lpResult = validateListingPrice(body, current.status as string, invalidFields);
  if (lpResult instanceof NextResponse) return lpResult;

  const newPlatforms = validatePlatforms(body, category, invalidFields);
  const newCondition = validateCondition(body, category, invalidFields);
  const clothingUpdates = validateClothingUpdates(body, category, invalidFields);
  const electronicsUpdates = validateElectronicsUpdates(body, category, invalidFields);

  return {
    resolvedListingPrice: lpResult,
    newCondition,
    newPlatforms,
    clothingUpdates,
    electronicsUpdates,
  };
}

// --- PATCH: write helpers (must run inside the caller's transaction) ------

// items (base table): bump updated_at, optionally write listing_price and
// insert a price_history row when the value actually changed.
function applyItemFieldUpdates(
  id: string,
  body: Record<string, unknown>,
  current: Record<string, unknown>,
  resolvedListingPrice: number | null | undefined,
): void {
  const itemSets: string[] = ["updated_at = datetime('now')"];
  const itemVals: unknown[] = [];

  if ('listing_price' in body) {
    itemSets.push('listing_price = ?');
    const newPrice = resolvedListingPrice ?? null;
    itemVals.push(newPrice);

    const oldPrice = current.listing_price as number | null;
    if (oldPrice !== newPrice) {
      db.prepare(
        // tenant_id must match the parent item's (migration 006's trigger
        // enforces this) -- current.tenant_id is already scoped by the
        // caller's WHERE id = ? AND tenant_id = ? lookup.
        "INSERT INTO price_history (id, item_id, tenant_id, previous_price, new_price, changed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        // DR-7: pass NULL (not 0) when there is no prior/new price, so the
        // audit trail distinguishes "unset" from a real 0.
      ).run(crypto.randomUUID(), id, current.tenant_id, oldPrice, newPrice);
    }
  }

  db.prepare(`UPDATE items SET ${itemSets.join(', ')} WHERE id = ?`).run(...itemVals, id);
}

// satellite table (book_details / clothing_details / electronics_details):
// condition + any category-specific fields present in the request.
//
// clothingUpdates/electronicsUpdates are mutually exclusive in practice --
// validateClothingUpdates/validateElectronicsUpdates each return `{}` for
// every category but their own -- so concatenating both entry lists here
// never produces a cross-category SET clause.
//
// Table-name resolution is an exhaustive 3-way switch (not a ternary chain):
// a missed category must fail to compile via the `never` check, not
// silently target the wrong satellite table.
function applyDetailUpdates(
  id: string,
  category: Category,
  newCondition: string | undefined,
  clothingUpdates: Record<string, unknown>,
  electronicsUpdates: Record<string, unknown>,
): void {
  const detailSets: string[] = [];
  const detailVals: unknown[] = [];
  if (newCondition !== undefined) {
    detailSets.push('condition = ?');
    detailVals.push(newCondition);
  }
  for (const [field, value] of Object.entries(clothingUpdates)) {
    detailSets.push(`${field} = ?`);
    detailVals.push(value);
  }
  for (const [field, value] of Object.entries(electronicsUpdates)) {
    detailSets.push(`${field} = ?`);
    detailVals.push(value);
  }
  if (detailSets.length > 0) {
    let table: string;
    switch (category) {
      case 'book':
        table = 'book_details';
        break;
      case 'clothing':
        table = 'clothing_details';
        break;
      case 'electronics':
        table = 'electronics_details';
        break;
      default: {
        const _exhaustive: never = category;
        throw new Error(`Unknown category: ${_exhaustive}`);
      }
    }
    db.prepare(`UPDATE ${table} SET ${detailSets.join(', ')} WHERE item_id = ?`).run(
      ...detailVals,
      id,
    );
  }
}

// item_platforms: replace-all. `newPlatforms === undefined` means
// 'platforms' was absent from the request — leave the set untouched.
function applyPlatformsReplace(
  id: string,
  tenantId: string,
  newPlatforms: string[] | undefined,
): void {
  if (newPlatforms === undefined) return;
  db.prepare('DELETE FROM item_platforms WHERE item_id = ?').run(id);
  const insertPlatform = db.prepare(
    // tenant_id must match the parent item's (migration 006's trigger).
    "INSERT INTO item_platforms (id, item_id, tenant_id, platform, listed_at) VALUES (?, ?, ?, ?, datetime('now'))",
  );
  for (const platform of newPlatforms) {
    insertPlatform.run(crypto.randomUUID(), id, tenantId, platform);
  }
}

function buildPatchResponse(id: string, category: Category): NextResponse {
  const updated = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown>;
  const details = fetchDetails(id, category);
  const platforms = fetchPlatforms(id);
  return NextResponse.json({ ...updated, details, platforms });
}

function mapPatchDbError(err: unknown): NextResponse {
  const code = (err as { code?: string }).code;
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    console.error('PATCH /api/items/[id] CHECK constraint:', err);
    return NextResponse.json({ error: 'Validation failed.' }, { status: 422 });
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.error('PATCH /api/items/[id] UNIQUE constraint:', err);
    return NextResponse.json({ error: 'Conflicts with an existing record.' }, { status: 409 });
  }
  console.error('PATCH /api/items/[id] error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await requireTenantAndParam(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { tenantId, id } = resolved;

    const parsedBody = await parseJsonBody(request);
    if ('error' in parsedBody) return parsedBody.error;
    const { body } = parsedBody;

    const current = db.prepare('SELECT * FROM items WHERE id = ? AND tenant_id = ?').get(
      id,
      tenantId,
    ) as Record<string, unknown> | undefined;
    if (!current) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    if (TERMINAL.includes(current.status as string)) {
      return NextResponse.json(
        { error: 'Cannot update item with terminal status.' },
        { status: 409 },
      );
    }

    const category = current.category as Category;

    const invalidFields: string[] = [];
    const outcome = validatePatchBody(body, current, category, invalidFields);
    if (outcome instanceof NextResponse) return outcome;

    const { resolvedListingPrice, newCondition, newPlatforms, clothingUpdates, electronicsUpdates } =
      outcome;

    if (invalidFields.length > 0) {
      return NextResponse.json({ error: 'Validation failed.', fields: invalidFields }, { status: 422 });
    }

    const noFieldsPresent =
      !('listing_price' in body) &&
      !('condition' in body) &&
      !('platforms' in body) &&
      Object.keys(clothingUpdates).length === 0 &&
      Object.keys(electronicsUpdates).length === 0;
    if (noFieldsPresent) {
      return NextResponse.json({ error: 'No fields to update.' }, { status: 422 });
    }

    db.transaction(() => {
      applyItemFieldUpdates(id, body, current, resolvedListingPrice);
      applyDetailUpdates(id, category, newCondition, clothingUpdates, electronicsUpdates);
      applyPlatformsReplace(id, current.tenant_id as string, newPlatforms);
    })();

    return buildPatchResponse(id, category);
  } catch (err) {
    return mapPatchDbError(err);
  }
}
