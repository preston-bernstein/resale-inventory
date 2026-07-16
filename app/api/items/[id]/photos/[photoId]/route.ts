import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { PHOTOS_ROOT } from '@/lib/photos';
import { requireTenant } from '@/lib/apiRequest';

// Standard UUIDv4 pattern — same as the sibling POST/PATCH route. The
// item_id path param must match this before it is used in any path.join()
// call — rejecting a malformed id up front is the first line of
// path-traversal defense (the second is the resolved-path prefix check
// performed right before each filesystem operation, below).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONTENT_TYPE_FOR_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

interface PhotoRow {
  id: string;
  path: string;
  sort_order: number;
}

// Resolves a photo row's stored `path` (`<item_id>/<uuid>.<ext>`) to a full
// filesystem path, the same safe way the POST route builds it: join the
// photos root, the (already-validated) item id, and the filename, then
// verify the resolved path is still contained under the item's directory.
// Defense in depth — these path segments come from the DB, not directly
// from user input, but the containment check costs nothing and matches the
// upload route's discipline.
function resolvePhotoPath(itemId: string, storedPath: string): string | null {
  const itemDir = path.resolve(path.join(PHOTOS_ROOT, itemId));
  const filename = path.basename(storedPath);
  const targetPath = path.resolve(path.join(itemDir, filename));

  if (!targetPath.startsWith(itemDir + path.sep)) {
    return null;
  }
  return targetPath;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;

    if (!UUID_V4_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid item id.' }, { status: 400 });
    }

    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    // Scoped by WHERE item_id = ? AND id = ? AND tenant_id = ?, never by id
    // alone — IDOR defense: a photoId belonging to a different item_id, or
    // to a different tenant's copy of item_photos, 404s here, the same as a
    // photoId that doesn't exist at all.
    const photo = db
      .prepare('SELECT id, path, sort_order FROM item_photos WHERE item_id = ? AND id = ? AND tenant_id = ?')
      .get(id, photoId, tenant.tenantId) as PhotoRow | undefined;

    if (!photo) {
      return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
    }

    const targetPath = resolvePhotoPath(id, photo.path);
    if (!targetPath) {
      return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(targetPath);
    } catch (err) {
      // DB row exists but the file is missing on disk (drift) — treat the
      // same as "not found" for a read, rather than a 500.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
      }
      throw err;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = CONTENT_TYPE_FOR_EXT[ext] ?? 'application/octet-stream';

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  } catch (err) {
    console.error('GET /api/items/[id]/photos/[photoId] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  try {
    const { id, photoId } = await params;

    if (!UUID_V4_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid item id.' }, { status: 400 });
    }

    const tenant = requireTenant(request);
    if (tenant instanceof NextResponse) return tenant;

    // Scoped by WHERE item_id = ? AND id = ? AND tenant_id = ?, never by id
    // alone — IDOR defense, same as GET: a photoId belonging to a different
    // item_id, or to a different tenant's copy of item_photos, 404s here,
    // identically to a photoId that doesn't exist at all.
    const photo = db
      .prepare('SELECT id, path, sort_order FROM item_photos WHERE item_id = ? AND id = ? AND tenant_id = ?')
      .get(id, photoId, tenant.tenantId) as PhotoRow | undefined;

    if (!photo) {
      return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
    }

    // Order of operations (mirrors, in reverse, the upload route's
    // file-then-row ordering): delete the item_photos row FIRST inside a
    // transaction, compacting the remaining rows' sort_order to be
    // contiguous starting from 1 in the same transaction, then — only
    // after the transaction commits — delete the file from disk. This
    // minimizes the window in which a row could point at a file that's
    // already gone; upload prefers an orphaned file over an orphaned DB
    // reference, delete prefers the same by removing the DB reference
    // first.
    const deletePhoto = db.prepare('DELETE FROM item_photos WHERE item_id = ? AND id = ?');
    const selectRemaining = db.prepare(
      'SELECT id, path, sort_order FROM item_photos WHERE item_id = ? ORDER BY sort_order',
    );
    const updateSortOrder = db.prepare(
      'UPDATE item_photos SET sort_order = ? WHERE id = ? AND item_id = ?',
    );

    const remaining = db.transaction(() => {
      deletePhoto.run(id, photoId);

      const rows = selectRemaining.all(id) as PhotoRow[];
      rows.forEach((row, idx) => {
        const newSortOrder = idx + 1;
        if (row.sort_order !== newSortOrder) {
          updateSortOrder.run(newSortOrder, row.id, id);
        }
        row.sort_order = newSortOrder;
      });

      return rows;
    })();

    const targetPath = resolvePhotoPath(id, photo.path);
    if (targetPath) {
      try {
        fs.unlinkSync(targetPath);
      } catch (err) {
        // Tolerate a missing file (ENOENT) without erroring; any other
        // error type is unexpected and is logged (but does not fail the
        // request — the DB row is already gone, which is the source of
        // truth).
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('DELETE /api/items/[id]/photos/[photoId] unlink error:', err);
        }
      }
    }

    return NextResponse.json({ photos: remaining });
  } catch (err) {
    console.error('DELETE /api/items/[id]/photos/[photoId] error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
