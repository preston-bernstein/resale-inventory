import Image from 'next/image';
import type { ItemWithRelations, Photo } from '@/lib/types';
import PhotoUpload from '@/components/PhotoUpload';
import PhoneHandoff from '@/components/PhoneHandoff';

export function HeroPhoto({ photo, itemId, title }: { photo: Photo; itemId: string; title: string }) {
  return (
    <div className="relative w-full aspect-[4/5] sm:aspect-video rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
      <Image
        src={`/api/items/${itemId}/photos/${photo.id}`}
        alt={title}
        fill
        sizes="(max-width: 640px) 100vw, 672px"
        className="object-cover"
        priority
      />
    </div>
  );
}

export function PhotosSection({
  item,
  onPhotosChange,
}: {
  item: ItemWithRelations;
  onPhotosChange: (photos: Photo[]) => void;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300">Photos</h2>
      <PhotoUpload itemId={item.id} photos={item.photos} onPhotosChange={onPhotosChange} />
      <PhoneHandoff itemId={item.id} onPhotosChange={onPhotosChange} />
    </section>
  );
}
