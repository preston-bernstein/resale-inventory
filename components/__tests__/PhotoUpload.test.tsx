// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhotoUpload from '@/components/PhotoUpload';
import type { Photo } from '@/lib/types';

// vitest.config.ts does not set test.globals: true, so Testing Library's
// automatic afterEach cleanup never registers — do it explicitly per file.
afterEach(cleanup);

const ITEM_ID = 'item-123';

function photo(id: string, sort_order: number): Photo {
  return { id, path: `/data/photos/${id}.jpg`, sort_order };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhotoUpload', () => {
  it('renders "No photos yet." for an empty photos array', () => {
    render(<PhotoUpload itemId={ITEM_ID} photos={[]} onPhotosChange={vi.fn()} />);
    expect(screen.getByText('No photos yet.')).toBeInTheDocument();
  });

  it('renders thumbnails with reorder/delete buttons for existing photos, in sort_order', () => {
    const photos = [photo('p2', 2), photo('p1', 1), photo('p3', 3)];
    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={vi.fn()} />);

    // <img alt=""> is computed as a decorative/presentation role per
    // HTML-AAM, so it's excluded from getByRole('img'); alt-text queries
    // match on the DOM attribute directly regardless of role, so use those.
    // next/image rewrites `src` through its /_next/image optimization
    // proxy (?url=<encoded original>&...), so assert on the encoded
    // original URL being present rather than an exact src match.
    const images = screen.getAllByAltText('');
    expect(images).toHaveLength(3);
    expect(images[0]).toHaveAttribute(
      'src',
      expect.stringContaining(encodeURIComponent(`/api/items/${ITEM_ID}/photos/p1`)),
    );
    expect(images[1]).toHaveAttribute(
      'src',
      expect.stringContaining(encodeURIComponent(`/api/items/${ITEM_ID}/photos/p2`)),
    );
    expect(images[2]).toHaveAttribute(
      'src',
      expect.stringContaining(encodeURIComponent(`/api/items/${ITEM_ID}/photos/p3`)),
    );

    expect(screen.getAllByRole('button', { name: '↑' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '↓' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(3);
  });

  it('disables the first photo\'s up button and the last photo\'s down button', () => {
    const photos = [photo('p1', 1), photo('p2', 2), photo('p3', 3)];
    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={vi.fn()} />);

    const upButtons = screen.getAllByRole('button', { name: '↑' });
    const downButtons = screen.getAllByRole('button', { name: '↓' });

    expect(upButtons[0]).toBeDisabled();
    expect(upButtons[1]).toBeEnabled();
    expect(upButtons[2]).toBeEnabled();

    expect(downButtons[0]).toBeEnabled();
    expect(downButtons[1]).toBeEnabled();
    expect(downButtons[2]).toBeDisabled();
  });

  it('shows a validation error and does not call fetch when submitting with no file chosen', async () => {
    const user = userEvent.setup();
    render(<PhotoUpload itemId={ITEM_ID} photos={[]} onPhotosChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Choose at least one photo.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uploads a file: calls fetch with FormData POST and onPhotosChange on success', async () => {
    const user = userEvent.setup();
    const onPhotosChange = vi.fn();
    const returnedPhotos = [photo('new-1', 1)];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ photos: returnedPhotos })
    );

    render(<PhotoUpload itemId={ITEM_ID} photos={[]} onPhotosChange={onPhotosChange} />);

    // no accessible label on the file input; query by type instead
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'test.png', { type: 'image/png' });
    await user.upload(input, file);

    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`/api/items/${ITEM_ID}/photos`);
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
    const formData = options.body as FormData;
    expect(formData.getAll('files')).toHaveLength(1);
    expect((formData.getAll('files')[0] as File).name).toBe('test.png');

    // PhotoUpload doesn't hold its own photos state — it just forwards the
    // API response up via onPhotosChange; the parent is responsible for
    // re-rendering it with the new `photos` prop. So assert the callback
    // rather than expecting this render to show a new thumbnail.
    await vi.waitFor(() => expect(onPhotosChange).toHaveBeenCalledWith(returnedPhotos));
  });

  it('shows a server error message on a failed upload', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: 'File too large.' }, false, 400)
    );

    render(<PhotoUpload itemId={ITEM_ID} photos={[]} onPhotosChange={vi.fn()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'big.png', { type: 'image/png' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('File too large.')).toBeInTheDocument();
  });

  it('deletes a photo: calls fetch DELETE and onPhotosChange with the remaining photos', async () => {
    const user = userEvent.setup();
    const onPhotosChange = vi.fn();
    const photos = [photo('p1', 1), photo('p2', 2)];
    const remaining = [photo('p2', 2)];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ photos: remaining }));

    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={onPhotosChange} />);

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[0]);

    expect(fetch).toHaveBeenCalledWith(`/api/items/${ITEM_ID}/photos/p1`, { method: 'DELETE' });
    expect(onPhotosChange).toHaveBeenCalledWith(remaining);
  });

  it('shows an action error message when delete fails', async () => {
    const user = userEvent.setup();
    const photos = [photo('p1', 1)];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: 'Cannot delete.' }, false, 400)
    );

    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Cannot delete.')).toBeInTheDocument();
  });

  it('moves a photo up: calls fetch PATCH with the swapped order and onPhotosChange with the result', async () => {
    const user = userEvent.setup();
    const onPhotosChange = vi.fn();
    const photos = [photo('p1', 1), photo('p2', 2), photo('p3', 3)];
    const reordered = [photo('p2', 1), photo('p1', 2), photo('p3', 3)];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ photos: reordered }));

    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={onPhotosChange} />);

    // move the second photo (p2, idx 1) up -> swaps with p1
    const upButtons = screen.getAllByRole('button', { name: '↑' });
    await user.click(upButtons[1]);

    expect(fetch).toHaveBeenCalledWith(`/api/items/${ITEM_ID}/photos`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['p2', 'p1', 'p3'] }),
    });
    expect(onPhotosChange).toHaveBeenCalledWith(reordered);
  });

  it('moves a photo down: calls fetch PATCH with the swapped order', async () => {
    const user = userEvent.setup();
    const onPhotosChange = vi.fn();
    const photos = [photo('p1', 1), photo('p2', 2), photo('p3', 3)];
    const reordered = [photo('p1', 1), photo('p3', 2), photo('p2', 3)];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ photos: reordered }));

    render(<PhotoUpload itemId={ITEM_ID} photos={photos} onPhotosChange={onPhotosChange} />);

    // move the second photo (p2, idx 1) down -> swaps with p3
    const downButtons = screen.getAllByRole('button', { name: '↓' });
    await user.click(downButtons[1]);

    expect(fetch).toHaveBeenCalledWith(`/api/items/${ITEM_ID}/photos`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['p1', 'p3', 'p2'] }),
    });
    expect(onPhotosChange).toHaveBeenCalledWith(reordered);
  });

  it('shows "Network error." when the upload fetch call rejects', async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    render(<PhotoUpload itemId={ITEM_ID} photos={[]} onPhotosChange={vi.fn()} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-image-bytes'], 'test.png', { type: 'image/png' });
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Network error.')).toBeInTheDocument();
  });
});
