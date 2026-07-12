'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { conditionsForCategory } from '@/lib/constants';
import type { ItemWithRelations, BookDetails, ClothingDetails, Photo } from '@/lib/types';
import PhotoUpload from '@/components/PhotoUpload';

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
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, { cache: 'no-store' } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ItemWithRelations = await res.json();
      setItem(data);
      setEditListingPrice(data.listing_price !== null ? (data.listing_price / 100).toFixed(2) : '');
      setEditPlatforms(data.platforms.join(', '));
      setEditCondition(data.details.condition);
      const transitions = STATUS_TRANSITIONS[data.status] ?? [];
      setNextStatus(transitions[0] ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load item.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchItem();
  }, [fetchItem]);

  async function handlePatch(e: React.FormEvent) {
    e.preventDefault();
    if (!item) return;
    setPatchLoading(true);
    setPatchError('');
    setPatchSuccess('');
    try {
      const body: Record<string, unknown> = {};
      const priceStr = editListingPrice.trim();
      if (priceStr !== '') {
        body.listing_price = Math.round(parseFloat(priceStr) * 100);
      }
      const platList = editPlatforms.split(',').map(p => p.trim()).filter(Boolean);
      body.platforms = platList;
      body.condition = editCondition;

      const res = await fetch(`/api/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setPatchSuccess('Saved.');
        await fetchItem();
      } else {
        const data = await res.json().catch(() => ({}));
        setPatchError(data.error ?? `Error ${res.status}`);
      }
    } catch {
      setPatchError('Network error.');
    } finally {
      setPatchLoading(false);
    }
  }

  async function handleStatusTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !nextStatus) return;
    setStatusLoading(true);
    setStatusError('');
    try {
      const body: Record<string, unknown> = { status: nextStatus };
      if (nextStatus === 'Sold') {
        if (salePrice.trim()) body.sale_price = Math.round(parseFloat(salePrice) * 100);
        if (salePlatform.trim()) body.sale_platform = salePlatform.trim();
        if (saleDate.trim()) body.sale_date = saleDate.trim();
      }
      const res = await fetch(`/api/items/${item.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchItem();
      } else {
        const data = await res.json().catch(() => ({}));
        setStatusError(data.error ?? `Error ${res.status}`);
      }
    } catch {
      setStatusError('Network error.');
    } finally {
      setStatusLoading(false);
    }
  }

  function handlePhotosChange(photos: Photo[]) {
    setItem(prev => (prev ? { ...prev, photos } : prev));
  }

  if (loading) {
    return <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>;
  }

  if (error || !item) {
    return (
      <div>
        <p className="text-sm text-red-600">{error ?? 'Item not found.'}</p>
        <Link href="/inventory" className="text-sm text-gray-600 underline mt-2 inline-block">← Inventory</Link>
      </div>
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(item.status);
  const transitions = STATUS_TRANSITIONS[item.status] ?? [];
  const grossProfit =
    item.status === 'Sold' && item.sale_price !== null ? item.sale_price - item.acquisition_cost : null;

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/inventory" className="text-sm text-gray-500 hover:text-gray-800">← Inventory</Link>
        <h1 className="text-xl font-semibold text-gray-900">{item.title}</h1>
      </div>

      {/* Item details */}
      <section className="border border-gray-200 rounded p-4 space-y-2 text-sm">
        <h2 className="font-medium text-gray-700 mb-2">Details</h2>
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

      {/* Photo gallery — clothing only (FR14/AC10: no photo UI on books) */}
      {item.category === 'clothing' && (
        <section className="border border-gray-200 rounded p-4 space-y-3 text-sm">
          <h2 className="font-medium text-gray-700">Photos</h2>
          <PhotoUpload itemId={item.id} photos={item.photos} onPhotosChange={handlePhotosChange} />
        </section>
      )}

      {/* Editable section — non-terminal only */}
      {!isTerminal && (
        <section className="border border-gray-200 rounded p-4 space-y-4 text-sm">
          <h2 className="font-medium text-gray-700">Edit Listing</h2>
          <form onSubmit={(e) => { void handlePatch(e); }} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Listing Price (USD)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={editListingPrice}
                onChange={e => setEditListingPrice(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Platforms (comma-separated)</label>
              <input
                type="text"
                value={editPlatforms}
                onChange={e => setEditPlatforms(e.target.value)}
                placeholder="eBay, Amazon"
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">Condition</label>
              <select
                value={editCondition}
                onChange={e => setEditCondition(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
              >
                {conditionsForCategory(item.category).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {patchError && <p className="text-xs text-red-600">{patchError}</p>}
            {patchSuccess && <p className="text-xs text-green-700">{patchSuccess}</p>}
            <button
              type="submit"
              disabled={patchLoading}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-gray-50 hover:bg-gray-100 disabled:opacity-50"
            >
              {patchLoading ? 'Saving…' : 'Save Changes'}
            </button>
          </form>
        </section>
      )}

      {/* Status transition */}
      {!isTerminal && transitions.length > 0 && (
        <section className="border border-gray-200 rounded p-4 space-y-4 text-sm">
          <h2 className="font-medium text-gray-700">Change Status</h2>
          <form onSubmit={(e) => { void handleStatusTransition(e); }} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">Transition to</label>
              <select
                value={nextStatus}
                onChange={e => setNextStatus(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
              >
                {transitions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {nextStatus === 'Sold' && (
              <>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Sale Price (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={salePrice}
                    onChange={e => setSalePrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Sale Platform</label>
                  <select
                    value={salePlatform}
                    onChange={e => setSalePlatform(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
                  >
                    <option value="">— select —</option>
                    {SALE_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Sale Date</label>
                  <input
                    type="date"
                    value={saleDate}
                    onChange={e => setSaleDate(e.target.value)}
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
                  />
                </div>
              </>
            )}

            {statusError && <p className="text-xs text-red-600">{statusError}</p>}
            <button
              type="submit"
              disabled={statusLoading || !nextStatus}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {statusLoading ? 'Updating…' : `Set to ${nextStatus || '…'}`}
            </button>
          </form>
        </section>
      )}

      {/* Price history */}
      {item.price_history.length > 0 && (
        <section className="border border-gray-200 rounded p-4 text-sm">
          <h2 className="font-medium text-gray-700 mb-3">Price History</h2>
          <table className="w-full text-xs border border-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-600 border-b border-gray-200">Previous</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600 border-b border-gray-200">New</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600 border-b border-gray-200">Changed At</th>
              </tr>
            </thead>
            <tbody>
              {item.price_history.map(row => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="px-3 py-2">{fmt(row.previous_price)}</td>
                  <td className="px-3 py-2">{fmt(row.new_price)}</td>
                  <td className="px-3 py-2">{new Date(row.changed_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
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
      <span className="w-40 text-gray-500 flex-shrink-0">{label}</span>
      <span className={highlight ? 'font-semibold text-green-700' : 'text-gray-900'}>{value}</span>
    </div>
  );
}
