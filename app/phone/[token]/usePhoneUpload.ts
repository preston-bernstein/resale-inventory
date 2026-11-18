import { useRef, useState } from 'react';

export interface UploadFeedback {
  kind: 'success' | 'error';
  message: string;
}

async function errorMessageFrom(res: Response): Promise<string> {
  return res
    .json()
    .then((data) => (typeof data?.error === 'string' ? data.error : 'Upload failed.'))
    .catch(() => 'Upload failed.');
}

async function postPhotos(itemId: string, token: string, files: FileList): Promise<Response> {
  const formData = new FormData();
  for (const file of Array.from(files)) formData.append('files', file);

  return fetch(`/api/items/${itemId}/photos`, {
    method: 'POST',
    headers: { 'X-Pairing-Token': token },
    body: formData,
  });
}

/** Upload state for the phone page. `itemId` is null until the session has loaded. */
export function usePhoneUpload(token: string, itemId: string | null) {
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<UploadFeedback | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function upload() {
    if (itemId === null) return;
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setFeedback({ kind: 'error', message: 'Choose at least one photo.' });
      return;
    }

    setUploading(true);
    setFeedback(null);
    try {
      const res = await postPhotos(itemId, token, files);
      if (res.ok) {
        setFeedback({ kind: 'success', message: `${files.length} photo(s) uploaded.` });
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        setFeedback({ kind: 'error', message: await errorMessageFrom(res) });
      }
    } catch (err) {
      console.error('handleUpload failed:', err);
      setFeedback({ kind: 'error', message: 'Network error. Upload failed.' });
    } finally {
      setUploading(false);
    }
  }

  return { fileInputRef, uploading, feedback, upload };
}
