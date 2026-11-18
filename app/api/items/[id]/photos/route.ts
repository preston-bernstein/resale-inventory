import type { NextRequest} from 'next/server';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { resolveToken } from '@/lib/pairingToken';
import { parseItemId, requireTenant, resolveOwnedItem, type IdParams } from '@/lib/apiRequest';
import { EXT_FOR_TYPE, sniffImageType } from './_upload/imageType';

// Matches the existing 10MB CSV-import cap (app/api/import/route.ts) — a
// reasonable default for a per-single-user local app, not an arbitrary
// number.
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;

// Mid-range marketplace photo-count limit — a reasonable default.
const MAX_PHOTOS_PER_ITEM = 20;

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface PhotoRow {
  id: string;
  path: string;
  sort_order: number;
}

function listPhotos(itemId: string): PhotoRow[] {
  return db
    .prepare('SELECT id, path, sort_order FROM item_photos WHERE item_id = ? ORDER BY sort_order')
    .all(itemId) as PhotoRow[];
}

function countPhotos(itemId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM item_photos WHERE item_id = ?').get(itemId) as {
    cnt: number;
  };
  return row.cnt;
}

type ItemForUpload = { id: string; category: string; tenant_id: string };

// Optional phone-handoff pairing-token check. Desktop uploads never send
// this header, so its absence falls straight through to the existing
// behavior, unchanged. When present, it must resolve to an active,
// unexpired token for THIS item — resolveToken already covers
// not-found/malformed/wrong-status/expired by returning null; the itemId
// comparison below additionally covers a token issued for a different item
// being replayed against this item's URL. Since a token only ever resolves
// to the single item it was issued for (see lib/pairingToken.ts's
// resolveToken/createToken, which are itemId-keyed throughout) and that
// item's tenant_id is immutable, this itemId check alone is sufficient to
// keep a pairing token scoped to its own tenant/item — a token minted for
// tenant A's item can never resolve to, or be replayed against, tenant B's
// item. The pairing-token branch deliberately does NOT call requireTenant()
// — see docs/reseller-multi-tenant-foundation/plan.md's "Two explicit
// exceptions" callout. Never log the raw header value.
function authorizePhotoUpload(request: NextRequest, item: ItemForUpload): NextResponse | null {
  const pairingToken = request.headers.get('X-Pairing-Token');
  if (pairingToken !== null) {
    const resolved = resolveToken(pairingToken);
    if (!resolved || resolved.itemId !== item.id) {
      return NextResponse.json({ error: 'Invalid or expired pairing token.' }, { status: 401 });
    }
    return null;
  }

  // Normal browser/cookie path (Task 17 retrofit): no pairing token was
  // presented, so this must be the tenant's own authenticated browser.
  // requireTenant() 401s on a missing/invalid session; a valid session for
  // a DIFFERENT tenant than this item's owner 404s, same as every other
  // tenant-scoped route (never leaks whether the item exists).
  const tenant = requireTenant(request);
  if (tenant instanceof NextResponse) return tenant;
  if (tenant.tenantId !== item.tenant_id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  return null;
}

interface UploadPhoto {
  buffer: Buffer;
  ext: string;
}

// 2. Each file's declared Content-Type AND magic bytes must indicate an
// image type — the declared Content-Type is never trusted alone.
// 3. Max size per photo: 10 MB.
async function validateUploadFiles(files: File[]): Promise<UploadPhoto[] | Response> {
  const photos: UploadPhoto[] = [];
  for (const file of files) {
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'File is not a valid image.' }, { status: 422 });
    }

    if (file.size > MAX_PHOTO_SIZE) {
      return new Response('File too large', { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length > MAX_PHOTO_SIZE) {
      return new Response('File too large', { status: 413 });
    }

    const sniffed = sniffImageType(buffer);
    if (!sniffed) {
      return NextResponse.json({ error: 'File is not a valid image.' }, { status: 422 });
    }

    photos.push({ buffer, ext: EXT_FOR_TYPE[sniffed] });
  }
  return photos;
}

interface PhotoDestination {
  itemDir: string;
  itemId: string;
  tenantId: string;
  existingCount: number;
}

/** Write one photo under the item directory; returns the file path and the row to insert for it. */
function writePhotoFile(
  dest: PhotoDestination,
  photo: UploadPhoto,
  sortOrder: number,
): { targetPath: string; row: PhotoRow } {
  // Stored filename is server-generated from the verified image type —
  // never from the original uploaded filename or its declared
  // Content-Type alone (path-traversal defense: the original filename
  // is never used or trusted anywhere).
  const photoId = uuidv4();
  const filename = `${uuidv4()}.${photo.ext}`;
  const targetPath = path.resolve(path.join(dest.itemDir, filename));

  // Resolved-path containment check: reject if the final path is not
  // still under the resolved item photo directory.
  if (!targetPath.startsWith(dest.itemDir + path.sep)) {
    throw new Error('Resolved photo path escapes the item photo directory.');
  }

  fs.writeFileSync(targetPath, photo.buffer);
  return { targetPath, row: { id: photoId, path: `${dest.itemId}/${filename}`, sort_order: sortOrder } };
}

function insertPhotoRows(dest: PhotoDestination, rows: PhotoRow[]): void {
  // tenant_id is set explicitly to the parent item's own tenant_id (never
  // from a request body/param) -- item_photos.tenant_id is NOT NULL with
  // only a placeholder default-tenant DEFAULT (see
  // data/migrations/006_tenant_scoping.sql), and a DB trigger rejects any
  // insert whose tenant_id doesn't match its parent item's, so omitting
  // it here would fail every upload for a non-default tenant.
  const insert = db.prepare(
    'INSERT INTO item_photos (id, item_id, tenant_id, path, sort_order) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction((rowsToInsert: PhotoRow[]) => {
    for (const row of rowsToInsert) {
      insert.run(row.id, dest.itemId, dest.tenantId, row.path, row.sort_order);
    }
  })(rows);
}

function removeFilesBestEffort(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup; an orphaned file is the accepted failure
      // mode here, so a failed unlink is not itself an error.
    }
  }
}

// Durability ordering (plan.md Risk area 5, deliberate): write each file to
// disk FIRST, then insert its item_photos row. A crash between the two
// steps leaves an orphaned FILE (harmless, cleanable later) rather than an
// orphaned DB ROW pointing at nothing. If the row insert fails, best-effort
// delete whatever files this request already wrote.
function writePhotoFiles(dest: PhotoDestination, photos: UploadPhoto[]): void {
  const written: string[] = [];
  const rows: PhotoRow[] = [];

  try {
    let nextSortOrder = dest.existingCount + 1;
    for (const photo of photos) {
      const { targetPath, row } = writePhotoFile(dest, photo, nextSortOrder++);
      written.push(targetPath);
      rows.push(row);
    }
    insertPhotoRows(dest, rows);
  } catch (err) {
    removeFilesBestEffort(written);
    throw err;
  }
}

/** Find the item and apply the clothing-only rule; returns the item or the 404/422 response. */
function loadUploadItem(id: string): ItemForUpload | NextResponse {
  // Item lookup stays unscoped by tenant here (Task 16's carve-out): both
  // the cookie/browser path AND the X-Pairing-Token branch need to read
  // category/tenant_id before either auth mechanism is evaluated. Tenant
  // enforcement happens inside authorizePhotoUpload, once we know which
  // auth mechanism this request is using.
  const item = db.prepare('SELECT id, category, tenant_id FROM items WHERE id = ?').get(id) as
    | ItemForUpload
    | undefined;
  if (!item) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // Deliberate product decision, not an accident: photos are clothing-only.
  if (item.category !== 'clothing') {
    return NextResponse.json(
      { error: `Photos are not supported for category '${item.category}'.` },
      { status: 422 },
    );
  }
  return item;
}

async function readUploadedFiles(request: NextRequest): Promise<File[] | NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart form data.' }, { status: 400 });
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided.' }, { status: 400 });
  }
  return files;
}

export async function POST(
  request: NextRequest,
  { params }: IdParams,
) {
  try {
    // 1. item_id path param must match the expected UUIDv4 format before
    // it's used in any file path.
    const parsed = await parseItemId(params);
    if (parsed instanceof NextResponse) return parsed;
    const { id } = parsed;

    const item = loadUploadItem(id);
    if (item instanceof NextResponse) return item;

    const authError = authorizePhotoUpload(request, item);
    if (authError) return authError;

    const files = await readUploadedFiles(request);
    if (files instanceof NextResponse) return files;

    const validated = await validateUploadFiles(files);
    if (validated instanceof Response) return validated;

    // 4. Max photo count per item: 20.
    const existingCount = countPhotos(id);
    if (existingCount + files.length > MAX_PHOTOS_PER_ITEM) {
      return NextResponse.json(
        { error: `Photo limit exceeded: an item may have at most ${MAX_PHOTOS_PER_ITEM} photos.` },
        { status: 422 },
      );
    }

    const itemDir = path.resolve(path.join(PHOTOS_ROOT, id));
    fs.mkdirSync(itemDir, { recursive: true });

    writePhotoFiles({ itemDir, itemId: id, tenantId: item.tenant_id, existingCount }, validated);

    // Full ordered list after append, sort_order = append order.
    return NextResponse.json({ photos: listPhotos(id) }, { status: 201 });
  } catch (err) {
    console.error('POST /api/items/[id]/photos error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

/**
 * Apply a new photo order. Exact-set validation happens inside a single
 * transaction before any row is written: `orderIds` must be EXACTLY the
 * item's current set of photo ids (no missing, no extra/unknown, no
 * duplicate) or nothing changes and this returns null.
 */
function reorderPhotos(id: string, orderIds: string[]): PhotoRow[] | null {
  return db.transaction(() => {
    const rows = db.prepare('SELECT id FROM item_photos WHERE item_id = ?').all(id) as {
      id: string;
    }[];
    const currentIds = new Set(rows.map((r) => r.id));
    const orderSet = new Set(orderIds);

    const isExactMatch =
      orderSet.size === orderIds.length &&
      orderSet.size === currentIds.size &&
      [...orderSet].every((pid) => currentIds.has(pid));

    if (!isExactMatch) return null;

    // 1-indexed, matching POST's append-order sort_order assignment.
    const update = db.prepare('UPDATE item_photos SET sort_order = ? WHERE id = ? AND item_id = ?');
    orderIds.forEach((photoId, idx) => {
      update.run(idx + 1, photoId, id);
    });

    return listPhotos(id);
  })();
}

export async function PATCH(
  request: NextRequest,
  { params }: IdParams,
) {
  try {
    const resolved = await resolveOwnedItem(request, params);
    if (resolved instanceof NextResponse) return resolved;
    const { id } = resolved;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const order = body.order;
    if (!Array.isArray(order) || !order.every((v) => typeof v === 'string')) {
      return NextResponse.json({ error: 'order must be an array of photo ids.' }, { status: 400 });
    }

    const result = reorderPhotos(id, order as string[]);
    if (result === null) {
      return NextResponse.json(
        { error: 'order must include every existing photo id exactly once.' },
        { status: 422 },
      );
    }

    return NextResponse.json({ photos: result });
  } catch (err) {
    console.error('PATCH /api/items/[id]/photos error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
