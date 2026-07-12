'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { conditionsForCategory } from '@/lib/constants';
import type { ItemWithRelations, BookDetails, ClothingDetails, Photo } from '@/lib/types';
import PhotoUpload from '@/components/PhotoUpload';
import PhoneHandoff from '@/components/PhoneHandoff';

const TERMINAL_STATUSES = new Set(['Sold', 'Removed', 'Donated', 'Discarded']);

const STATUS_TRANSITIONS: Record<string, string[]> = {
  Unlisted: ['Listed', 'Donated', 'Discarded'],
  Listed: ['Unlisted', 'Sale Pending', 'Removed', 'Donated', 'Discarded'],
  'Sale Pending': ['Listed', 'Sold'],
};

const SALE_PLATFORMS = ['eBay', 'Amazon', 'ThriftBooks', 'AbeBooks', 'Facebook Marketplace', 'Other'];

const MEASUREMENT_LABELS: Record<string, string> = {
  pit_to_pit_in: 'Pit to Pit',
  length_in: 'Length',
  sleeve_length_in: 'Sleeve Length',
  waist_in: 'Waist',
  rise_in: 'Rise',
  inseam_in: 'Inseam',
  leg_opening_in: 'Leg Opening',
  hip_in: 'Hip',
};

const MEASUREMENT_FIELDS = [
  'pit_to_pit_in',
  'length_in',
  'sleeve_length_in',
  'waist_in',
  'rise_in',
  'inseam_in',
  'leg_opening_in',
  'hip_in',
] as const;

function fmt(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

// Pure request-body builders, split out of the event handlers so the
// handlers themselves are just fetch/state orchestration.
function buildPatchBody(
  editListingPrice: string,
  editPlatforms: string,
  editCondition: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const priceStr = editListingPrice.trim();
  if (priceStr !== '') {
    body.listing_price = Math.round(parseFloat(priceStr) * 100);
  }
  const platList = editPlatforms.split(',').map(p => p.trim()).filter(Boolean);
  body.platforms = platList;
  body.condition = editCondition;
  return body;
}

function buildStatusTransitionBody(
  nextStatus: string,
  salePrice: string,
  salePlatform: string,
  saleDate: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === 'Sold') {
    if (salePrice.trim()) body.sale_price = Math.round(parseFloat(salePrice) * 100);
    if (salePlatform.trim()) body.sale_platform = salePlatform.trim();
    if (saleDate.trim()) body.sale_date = saleDate.trim();
  }
  return body;
}

// Request/response orchestration, split out of the component so the
// component's own body is just wiring hooks to these calls. Each takes the
// state it needs plus the setters it updates as plain arguments — no
// closures over component scope, no custom hook.

interface LoadItemActions {
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  setItem: (v: ItemWithRelations | null) => void;
  setEditListingPrice: (v: string) => void;
  setEditPlatforms: (v: string) => void;
  setEditCondition: (v: string) => void;
  setNextStatus: (v: string) => void;
}

async function loadItem(id: string, actions: LoadItemActions): Promise<void> {
  actions.setLoading(true);
  actions.setError(null);
  try {
    const res = await fetch(`/api/items/${id}`, { cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: ItemWithRelations = await res.json();
    actions.setItem(data);
    actions.setEditListingPrice(data.listing_price !== null ? (data.listing_price / 100).toFixed(2) : '');
    actions.setEditPlatforms(data.platforms.join(', '));
    actions.setEditCondition(data.details.condition);
    const transitions = STATUS_TRANSITIONS[data.status] ?? [];
    actions.setNextStatus(transitions[0] ?? '');
  } catch (err) {
    actions.setError(err instanceof Error ? err.message : 'Failed to load item.');
  } finally {
    actions.setLoading(false);
  }
}

interface PatchFormFields {
  editListingPrice: string;
  editPlatforms: string;
  editCondition: string;
}

interface PatchActions {
  setPatchLoading: (v: boolean) => void;
  setPatchError: (v: string) => void;
  setPatchSuccess: (v: string) => void;
  refetch: () => Promise<void>;
}

async function submitPatch(
  itemId: string,
  fields: PatchFormFields,
  actions: PatchActions,
): Promise<void> {
  actions.setPatchLoading(true);
  actions.setPatchError('');
  actions.setPatchSuccess('');
  try {
    const body = buildPatchBody(fields.editListingPrice, fields.editPlatforms, fields.editCondition);
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      actions.setPatchSuccess('Saved.');
      await actions.refetch();
    } else {
      const data = await res.json().catch(() => ({}));
      actions.setPatchError(data.error ?? `Error ${res.status}`);
    }
  } catch {
    actions.setPatchError('Network error.');
  } finally {
    actions.setPatchLoading(false);
  }
}

interface StatusTransitionFields {
  nextStatus: string;
  salePrice: string;
  salePlatform: string;
  saleDate: string;
}

interface StatusTransitionActions {
  setStatusLoading: (v: boolean) => void;
  setStatusError: (v: string) => void;
  refetch: () => Promise<void>;
}

async function submitStatusTransition(
  itemId: string,
  fields: StatusTransitionFields,
  actions: StatusTransitionActions,
): Promise<void> {
  actions.setStatusLoading(true);
  actions.setStatusError('');
  try {
    const body = buildStatusTransitionBody(
      fields.nextStatus,
      fields.salePrice,
      fields.salePlatform,
      fields.saleDate,
    );
    const res = await fetch(`/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await actions.refetch();
    } else {
      const data = await res.json().catch(() => ({}));
      actions.setStatusError(data.error ?? `Error ${res.status}`);
    }
  } catch {
    actions.setStatusError('Network error.');
  } finally {
    actions.setStatusLoading(false);
  }
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [item, setItem] = useState<ItemWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit fields
  const [editListingPrice, setEditListingPrice] = useState('');
  const [editPlatforms, setEditPlatforms] = useState('');
  const [editCondition, setEditCondition] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState('');
  const [patchSuccess, setPatchSuccess] = useState('');

  // Status transition
  const [nextStatus, setNextStatus] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [salePlatform, setSalePlatform] = useState('');
  const [saleDate, setSaleDate] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  const fetchItem = useCallback(async () => {
    await loadItem(id, {
      setLoading,
      setError,
      setItem,
      setEditListingPrice,
      setEditPlatforms,
      setEditCondition,
      setNextStatus,
    });
  }, [id]);

  useEffect(() => {
    void fetchItem();
  }, [fetchItem]);

  async function handlePatch(e: React.FormEvent) {
    e.preventDefault();
    if (!item) return;
    await submitPatch(
      item.id,
      { editListingPrice, editPlatforms, editCondition },
      { setPatchLoading, setPatchError, setPatchSuccess, refetch: fetchItem },
    );
  }

  async function handleStatusTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !nextStatus) return;
    await submitStatusTransition(
      item.id,
      { nextStatus, salePrice, salePlatform, saleDate },
      { setStatusLoading, setStatusError, refetch: fetchItem },
    );
  }

  function handlePhotosChange(photos: Photo[]) {
    setItem(prev => (prev ? { ...prev, photos } : prev));
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !item) {
    return <ErrorState message={error ?? 'Item not found.'} />;
  }

  const derived = deriveItemView(item);

  const editForm: EditFormProps = {
    price: editListingPrice,
    onPriceChange: setEditListingPrice,
    platforms: editPlatforms,
    onPlatformsChange: setEditPlatforms,
    condition: editCondition,
    onConditionChange: setEditCondition,
    loading: patchLoading,
    error: patchError,
    success: patchSuccess,
    onSubmit: (e) => { void handlePatch(e); },
  };

  const statusForm: StatusFormProps = {
    nextStatus,
    onNextStatusChange: setNextStatus,
    salePrice,
    onSalePriceChange: setSalePrice,
    salePlatform,
    onSalePlatformChange: setSalePlatform,
    saleDate,
    onSaleDateChange: setSaleDate,
    loading: statusLoading,
    error: statusError,
    onSubmit: (e) => { void handleStatusTransition(e); },
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/inventory" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200">← Inventory</Link>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{item.title}</h1>
      </div>

      <ItemSections
        item={item}
        derived={derived}
        onPhotosChange={handlePhotosChange}
        editForm={editForm}
        statusForm={statusForm}
      />
    </div>
  );
}

interface DerivedItemView {
  isTerminal: boolean;
  transitions: string[];
  grossProfit: number | null;
  heroPhoto: Photo | null;
}

// Pure derivation of the view-only values computed from `item` — split out
// so ItemDetailPage's own body doesn't carry this branching.
function deriveItemView(item: ItemWithRelations): DerivedItemView {
  const isTerminal = TERMINAL_STATUSES.has(item.status);
  const transitions = STATUS_TRANSITIONS[item.status] ?? [];
  const grossProfit =
    item.status === 'Sold' && item.sale_price !== null ? item.sale_price - item.acquisition_cost : null;
  const heroPhoto =
    item.category === 'clothing' && item.photos.length > 0
      ? [...item.photos].sort((a, b) => a.sort_order - b.sort_order)[0]
      : null;
  return { isTerminal, transitions, grossProfit, heroPhoto };
}

interface EditFormProps {
  price: string;
  onPriceChange: (value: string) => void;
  platforms: string;
  onPlatformsChange: (value: string) => void;
  condition: string;
  onConditionChange: (value: string) => void;
  loading: boolean;
  error: string;
  success: string;
  onSubmit: (e: React.FormEvent) => void;
}

interface StatusFormProps {
  nextStatus: string;
  onNextStatusChange: (value: string) => void;
  salePrice: string;
  onSalePriceChange: (value: string) => void;
  salePlatform: string;
  onSalePlatformChange: (value: string) => void;
  saleDate: string;
  onSaleDateChange: (value: string) => void;
  loading: boolean;
  error: string;
  onSubmit: (e: React.FormEvent) => void;
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

function HeroPhoto({ photo, itemId, title }: { photo: Photo; itemId: string; title: string }) {
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

function DetailsSection({ item, grossProfit }: { item: ItemWithRelations; grossProfit: number | null }) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-2 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300 mb-2">Details</h2>
      <Row label="Title" value={item.title} />
      {item.category === 'book' ? (
        <BookDetailRows details={item.details as BookDetails} />
      ) : (
        <ClothingDetailRows details={item.details as ClothingDetails} />
      )}
      <Row label="Status" value={item.status} />
      <Row label="Acquisition Cost" value={fmt(item.acquisition_cost)} />
      <Row label="Acquisition Date" value={fmtDate(item.acquisition_date)} />
      <Row label="Listing Price" value={fmt(item.listing_price)} />
      <Row label="Platforms" value={item.platforms.length > 0 ? item.platforms.join(', ') : '—'} />
      {item.status === 'Sold' || item.sale_price !== null ? (
        <>
          <Row label="Sale Price" value={fmt(item.sale_price)} />
          <Row label="Sale Platform" value={item.sale_platform ?? '—'} />
          <Row label="Sale Date" value={fmtDate(item.sale_date)} />
        </>
      ) : null}
      {item.status === 'Sold' && grossProfit !== null && (
        <Row label="Gross Profit" value={fmt(grossProfit)} highlight />
      )}
    </section>
  );
}

function PhotosSection({
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

function EditListingForm({
  category,
  form,
}: {
  category: ItemWithRelations['category'];
  form: EditFormProps;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300">Edit Listing</h2>
      <form onSubmit={form.onSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Listing Price (USD)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.price}
            onChange={e => form.onPriceChange(e.target.value)}
            placeholder="0.00"
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Platforms (comma-separated)</label>
          <input
            type="text"
            value={form.platforms}
            onChange={e => form.onPlatformsChange(e.target.value)}
            placeholder="eBay, Amazon"
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Condition</label>
          <select
            value={form.condition}
            onChange={e => form.onConditionChange(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          >
            {conditionsForCategory(category).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {form.error && <p className="text-xs text-red-600 dark:text-red-400">{form.error}</p>}
        {form.success && <p className="text-xs text-green-700 dark:text-green-400">{form.success}</p>}
        <button
          type="submit"
          disabled={form.loading}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
        >
          {form.loading ? 'Saving…' : 'Save Changes'}
        </button>
      </form>
    </section>
  );
}

function ChangeStatusForm({
  transitions,
  form,
}: {
  transitions: string[];
  form: StatusFormProps;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300">Change Status</h2>
      <form onSubmit={form.onSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Transition to</label>
          <select
            value={form.nextStatus}
            onChange={e => form.onNextStatusChange(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          >
            {transitions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {form.nextStatus === 'Sold' && (
          <>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Sale Price (USD)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.salePrice}
                onChange={e => form.onSalePriceChange(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Sale Platform</label>
              <select
                value={form.salePlatform}
                onChange={e => form.onSalePlatformChange(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
              >
                <option value="">— select —</option>
                {SALE_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Sale Date</label>
              <input
                type="date"
                value={form.saleDate}
                onChange={e => form.onSaleDateChange(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
              />
            </div>
          </>
        )}

        {form.error && <p className="text-xs text-red-600 dark:text-red-400">{form.error}</p>}
        <button
          type="submit"
          disabled={form.loading || !form.nextStatus}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50"
        >
          {form.loading ? 'Updating…' : `Set to ${form.nextStatus || '…'}`}
        </button>
      </form>
    </section>
  );
}

function PriceHistoryTable({ priceHistory }: { priceHistory: ItemWithRelations['price_history'] }) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300 mb-3">Price History</h2>
      <table className="w-full text-xs border border-gray-200 dark:border-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">Previous</th>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">New</th>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">Changed At</th>
          </tr>
        </thead>
        <tbody>
          {priceHistory.map(row => (
            <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800">
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{fmt(row.previous_price)}</td>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{fmt(row.new_price)}</td>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{new Date(row.changed_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BookDetailRows({ details }: { details: BookDetails }) {
  return (
    <>
      <Row label="Author" value={details.author} />
      <Row label="Publisher" value={details.publisher ?? '—'} />
      <Row label="ISBN" value={details.isbn ?? '—'} />
      <Row label="Condition" value={details.condition} />
    </>
  );
}

function ClothingDetailRows({ details }: { details: ClothingDetails }) {
  return (
    <>
      <Row label="Brand" value={details.brand} />
      <Row label="Size" value={details.size_label} />
      {details.color !== null && <Row label="Color" value={details.color} />}
      {details.material !== null && <Row label="Material" value={details.material} />}
      {details.gender_department !== null && <Row label="Department" value={details.gender_department} />}
      {details.weight_oz !== null && <Row label="Weight" value={`${details.weight_oz} oz`} />}
      {MEASUREMENT_FIELDS.map(field =>
        details[field] !== null ? (
          <Row key={field} label={MEASUREMENT_LABELS[field]} value={`${details[field]}"`} />
        ) : null,
      )}
      <Row label="Condition" value={details.condition} />
    </>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-40 text-gray-500 dark:text-gray-400 flex-shrink-0">{label}</span>
      <span className={highlight ? 'font-semibold text-green-700 dark:text-green-400' : 'text-gray-900 dark:text-gray-100'}>{value}</span>
    </div>
  );
}
