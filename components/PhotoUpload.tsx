'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import type { Photo } from '@/lib/types';
import { optimizeImageFile } from '@/lib/imageOptimize';

interface PhotoUploadProps {
  itemId: string;
  photos: Photo[];
  onPhotosChange: (photos: Photo[]) => void;
}

/**
 * Run one photos-endpoint request and resolve it into either the updated
 * photo list or a caller-facing error message — the fetch/ok-check/parse/
 * catch shape shared by handleUpload, handleDelete, and handleMove below,
 * which previously repeated it verbatim. Logs the real error to the console
 * (invisible in the UI, useful when the operator reports "it didn't work").
 */
async function requestPhotoUpdate(
  requestFn: () => Promise<Response>,
  actionName: string,
): Promise<{ photos: Photo[] } | { error: string }> {
  try {
    const res = await requestFn();
    if (res.ok) {
      const data = await res.json();
      return { photos: data.photos };
    }
    const data = await res.json().catch(() => ({}));
    return { error: data.error ?? `Error ${res.status}` };
  } catch (err) {
    console.error(`${actionName} failed:`, err);
    return { error: 'Network error.' };
  }
}

type PhotosChange = (photos: Photo[]) => void;

/** Upload form state: the file input ref, the loading flag, the error text, and the submit handler. */
function usePhotoUploadForm(itemId: string, onPhotosChange: PhotosChange) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setUploadError('Choose at least one photo.');
      return;
    }
    setUploadLoading(true);
    setUploadError('');
    const result = await requestPhotoUpdate(async () => {
      const optimized = await Promise.all(Array.from(files).map(optimizeImageFile));
      const formData = new FormData();
      for (const file of optimized) formData.append('files', file);
      return fetch(`/api/items/${itemId}/photos`, { method: 'POST', body: formData });
    }, 'handleUpload');
    if ('photos' in result) {
      onPhotosChange(result.photos);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } else {
      setUploadError(result.error);
    }
    setUploadLoading(false);
  }

  return { fileInputRef, uploadLoading, uploadError, handleUpload };
}

/** Per-photo delete and reorder state: which photo is busy, the action error text, and the two handlers. */
function usePhotoActions(itemId: string, sorted: Photo[], onPhotosChange: PhotosChange) {
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  async function handleDelete(photoId: string) {
    setBusyPhotoId(photoId);
    setActionError('');
    const result = await requestPhotoUpdate(
      () => fetch(`/api/items/${itemId}/photos/${photoId}`, { method: 'DELETE' }),
      'handleDelete',
    );
    if ('photos' in result) {
      onPhotosChange(result.photos);
    } else {
      setActionError(result.error);
    }
    setBusyPhotoId(null);
  }

  async function handleMove(photoId: string, direction: -1 | 1) {
    const idx = sorted.findIndex(p => p.id === photoId);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;

    const reordered = [...sorted];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    const order = reordered.map(p => p.id);

    setBusyPhotoId(photoId);
    setActionError('');
    const result = await requestPhotoUpdate(
      () => fetch(`/api/items/${itemId}/photos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      }),
      'handleMove',
    );
    if ('photos' in result) {
      onPhotosChange(result.photos);
    } else {
      setActionError(result.error);
    }
    setBusyPhotoId(null);
  }

  return { busyPhotoId, actionError, handleDelete, handleMove };
}

function ShotChecklist() {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
      <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">Shot checklist</p>
      <p>Hero (on-body) → Back → Brand/size tag → Fabric tag → Any flaw, honestly → Measurement (tape visible) → Detail</p>
      <p className="mt-1 text-gray-500 dark:text-gray-400">Natural light near a window, no flash · plain background · tap to focus on the fabric</p>
    </div>
  );
}

interface PhotoTileProps {
  itemId: string;
  photo: Photo;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onMove: (photoId: string, direction: -1 | 1) => void;
  onDelete: (photoId: string) => void;
}

function PhotoTile({ itemId, photo, isFirst, isLast, busy, onMove, onDelete }: PhotoTileProps) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
      <div className="relative w-full h-28 bg-gray-50 dark:bg-gray-900">
        <Image
          src={`/api/items/${itemId}/photos/${photo.id}`}
          alt=""
          fill
          sizes="(max-width: 640px) 33vw, 200px"
          className="object-cover"
        />
      </div>
      <div className="flex items-center justify-between px-1.5 py-1 bg-gray-50 dark:bg-gray-800/50 text-xs border-t border-gray-200 dark:border-gray-700">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => { onMove(photo.id, -1); }}
            disabled={isFirst || busy}
            className="px-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-40"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => { onMove(photo.id, 1); }}
            disabled={isLast || busy}
            className="px-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-40"
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          onClick={() => { onDelete(photo.id); }}
          disabled={busy}
          className="px-1.5 border border-gray-300 dark:border-gray-600 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

interface UploadFormProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
}

function UploadForm({ fileInputRef, loading, onSubmit }: UploadFormProps) {
  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2 flex-wrap">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="text-xs text-gray-600 dark:text-gray-400"
      />
      <button
        type="submit"
        disabled={loading}
        className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
      >
        {loading ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}

// Up/down arrow reordering rather than drag-and-drop: this project has no
// drag-and-drop library, and arrow buttons achieve the same reordering
// capability with zero new dependencies — a simpler, defensible choice that
// matches the app's minimal UX standard.
export default function PhotoUpload({ itemId, photos, onPhotosChange }: PhotoUploadProps) {
  const { fileInputRef, uploadLoading, uploadError, handleUpload } = usePhotoUploadForm(itemId, onPhotosChange);
  const sorted = [...photos].sort((a, b) => a.sort_order - b.sort_order);
  const { busyPhotoId, actionError, handleDelete, handleMove } = usePhotoActions(itemId, sorted, onPhotosChange);

  return (
    <div className="space-y-3">
      <ShotChecklist />

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No photos yet.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {sorted.map((photo, idx) => (
            <PhotoTile
              key={photo.id}
              itemId={itemId}
              photo={photo}
              isFirst={idx === 0}
              isLast={idx === sorted.length - 1}
              busy={busyPhotoId !== null}
              onMove={(id, direction) => { void handleMove(id, direction); }}
              onDelete={(id) => { void handleDelete(id); }}
            />
          ))}
        </div>
      )}

      {actionError && <p className="text-xs text-red-600 dark:text-red-400">{actionError}</p>}

      <UploadForm fileInputRef={fileInputRef} loading={uploadLoading} onSubmit={(e) => { void handleUpload(e); }} />
      {uploadError && <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>}
    </div>
  );
}
