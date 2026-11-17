'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { ItemWithRelations, Photo } from '@/lib/types';
import { DetailsSection, PriceHistoryTable } from './ItemDetails';
import { ChangeStatusForm, EditListingForm, type EditFormProps, type StatusFormProps } from './ItemForms';
import { HeroPhoto, PhotosSection } from './ItemPhotos';
import { deriveItemView, type DerivedItemView } from './itemStatus';
import { useItemDetail } from './useItemDetail';

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { item, loading, error, editForm, statusForm, handlePhotosChange } = useItemDetail(id);

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !item) {
    return <ErrorState message={error ?? 'Item not found.'} />;
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/inventory" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">← Inventory</Link>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{item.title}</h1>
      </div>

      <ItemSections
        item={item}
        derived={deriveItemView(item)}
        onPhotosChange={handlePhotosChange}
        editForm={editForm}
        statusForm={statusForm}
      />
    </div>
  );
}

// All of the conditionally-rendered sections below the page header, kept as
// one component so the section-visibility rules (hero photo, clothing-only
// Photos, non-terminal edit/status forms, non-empty price history) live
// together instead of inline in ItemDetailPage's return. Form state is
// passed as two grouped objects rather than individually so this stays a
// small, fixed number of props regardless of how many fields each form has.
function ItemSections({
  item,
  derived,
  onPhotosChange,
  editForm,
  statusForm,
}: {
  item: ItemWithRelations;
  derived: DerivedItemView;
  onPhotosChange: (photos: Photo[]) => void;
  editForm: EditFormProps;
  statusForm: StatusFormProps;
}) {
  const { isTerminal, transitions, grossProfit, heroPhoto } = derived;

  return (
    <>
      {heroPhoto && <HeroPhoto photo={heroPhoto} itemId={item.id} title={item.title} />}

      <DetailsSection item={item} grossProfit={grossProfit} />

      {/* Photo gallery — clothing only (FR14/AC10: no photo UI on books) */}
      {item.category === 'clothing' && <PhotosSection item={item} onPhotosChange={onPhotosChange} />}

      {/* Editable section — non-terminal only */}
      {!isTerminal && <EditListingForm category={item.category} form={editForm} />}

      {/* Status transition */}
      {!isTerminal && transitions.length > 0 && (
        <ChangeStatusForm transitions={transitions} form={statusForm} />
      )}

      {/* Price history */}
      {item.price_history.length > 0 && <PriceHistoryTable priceHistory={item.price_history} />}
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8 max-w-2xl animate-pulse motion-reduce:animate-none" aria-hidden="true">
      <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
      <div className="w-full aspect-[4/5] sm:aspect-video rounded-lg bg-gray-200 dark:bg-gray-700" />
      <div className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-3.5 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div>
      <p className="text-sm text-red-600 dark:text-red-400">{message}</p>
      <Link href="/inventory" className="text-sm text-gray-600 dark:text-gray-400 underline mt-2 inline-block">← Inventory</Link>
    </div>
  );
}
