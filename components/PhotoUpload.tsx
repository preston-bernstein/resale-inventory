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

// Up/down arrow reordering rather than drag-and-drop: this project has no
// drag-and-drop library, and arrow buttons achieve the same reordering
// capability with zero new dependencies — a simpler, defensible choice that
// matches the app's minimal UX standard.
export default function PhotoUpload({ itemId, photos, onPhotosChange }: PhotoUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const sorted = [...photos].sort((a, b) => a.sort_order - b.sort_order);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setUploadError('Choose at least one photo.');
      return;
    }
    setUploadLoading(true);
    setUploadError('');
    try {
      const optimized = await Promise.all(Array.from(files).map(optimizeImageFile));
      const formData = new FormData();
      for (const file of optimized) formData.append('files', file);

      const res = await fetch(`/api/items/${itemId}/photos`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        onPhotosChange(data.photos);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        const data = await res.json().catch(() => ({}));
        setUploadError(data.error ?? `Error ${res.status}`);
      }
    } catch {
      setUploadError('Network error.');
    } finally {
      setUploadLoading(false);
    }
  }

  async function handleDelete(photoId: string) {
    setBusyPhotoId(photoId);
    setActionError('');
    try {
      const res = await fetch(`/api/items/${itemId}/photos/${photoId}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        onPhotosChange(data.photos);
      } else {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? `Error ${res.status}`);
      }
    } catch {
      setActionError('Network error.');
    } finally {
      setBusyPhotoId(null);
    }
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
    try {
      const res = await fetch(`/api/items/${itemId}/photos`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (res.ok) {
        const data = await res.json();
        onPhotosChange(data.photos);
      } else {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? `Error ${res.status}`);
      }
    } catch {
      setActionError('Network error.');
    } finally {
      setBusyPhotoId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
        <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">Shot checklist</p>
        <p>Hero (on-body) → Back → Brand/size tag → Fabric tag → Any flaw, honestly → Measurement (tape visible) → Detail</p>
        <p className="mt-1 text-gray-500 dark:text-gray-400">Natural light near a window, no flash · plain background · tap to focus on the fabric</p>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No photos yet.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {sorted.map((photo, idx) => (
            <div key={photo.id} className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
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
                    onClick={() => { void handleMove(photo.id, -1); }}
                    disabled={idx === 0 || busyPhotoId !== null}
                    className="px-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleMove(photo.id, 1); }}
                    disabled={idx === sorted.length - 1 || busyPhotoId !== null}
                    className="px-1.5 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-40"
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleDelete(photo.id); }}
                  disabled={busyPhotoId !== null}
                  className="px-1.5 border border-gray-300 dark:border-gray-600 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {actionError && <p className="text-xs text-red-600 dark:text-red-400">{actionError}</p>}

      <form onSubmit={(e) => { void handleUpload(e); }} className="flex items-center gap-2 flex-wrap">
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
          disabled={uploadLoading}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
        >
          {uploadLoading ? 'Uploading…' : 'Upload'}
        </button>
      </form>
      {uploadError && <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>}
    </div>
  );
}
