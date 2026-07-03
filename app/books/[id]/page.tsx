'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const CONDITIONS = ['Poor', 'Acceptable', 'Good', 'Very Good', 'Like New'] as const;

const TERMINAL_STATUSES = new Set(['Sold', 'Removed', 'Donated', 'Discarded']);

const STATUS_TRANSITIONS: Record<string, string[]> = {
  Unlisted: ['Listed', 'Donated', 'Discarded'],
  Listed: ['Unlisted', 'Sale Pending', 'Removed', 'Donated', 'Discarded'],
  'Sale Pending': ['Listed', 'Sold'],
};

const SALE_PLATFORMS = ['eBay', 'Amazon', 'ThriftBooks', 'AbeBooks', 'Facebook Marketplace', 'Other'];

interface PriceHistoryRow {
  id: string;
  book_id: string;
  previous_price: number | null;
  new_price: number | null;
  changed_at: string;
}

interface Book {
  id: string;
  isbn: string | null;
  title: string;
  author: string;
  publisher: string | null;
  condition: string;
  acquisition_cost: number;
  acquisition_date: string;
  status: string;
  listing_price: number | null;
  sale_price: number | null;
  sale_platform: string | null;
  sale_date: string | null;
  gross_profit: number | null;
  platforms: string[];
  price_history: PriceHistoryRow[];
}

function fmt(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export default function BookDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [book, setBook] = useState<Book | null>(null);
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

  const fetchBook = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/books/${id}`, { cache: 'no-store' } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Book = await res.json();
      setBook(data);
      setEditListingPrice(data.listing_price !== null ? (data.listing_price / 100).toFixed(2) : '');
      setEditPlatforms(data.platforms.join(', '));
      setEditCondition(data.condition);
      const transitions = STATUS_TRANSITIONS[data.status] ?? [];
      setNextStatus(transitions[0] ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load book.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchBook();
  }, [fetchBook]);

  async function handlePatch(e: React.FormEvent) {
    e.preventDefault();
    if (!book) return;
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

      const res = await fetch(`/api/books/${book.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setPatchSuccess('Saved.');
        await fetchBook();
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
    if (!book || !nextStatus) return;
    setStatusLoading(true);
    setStatusError('');
    try {
      const body: Record<string, unknown> = { status: nextStatus };
      if (nextStatus === 'Sold') {
        if (salePrice.trim()) body.sale_price = Math.round(parseFloat(salePrice) * 100);
        if (salePlatform.trim()) body.sale_platform = salePlatform.trim();
        if (saleDate.trim()) body.sale_date = saleDate.trim();
      }
      const res = await fetch(`/api/books/${book.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchBook();
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

  if (loading) {
    return <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>;
  }

  if (error || !book) {
    return (
      <div>
        <p className="text-sm text-red-600">{error ?? 'Book not found.'}</p>
        <Link href="/books" className="text-sm text-gray-600 underline mt-2 inline-block">← Back to Books</Link>
      </div>
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(book.status);
  const transitions = STATUS_TRANSITIONS[book.status] ?? [];

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/books" className="text-sm text-gray-500 hover:text-gray-800">← Books</Link>
        <h1 className="text-xl font-semibold text-gray-900">{book.title}</h1>
      </div>

      {/* Book details */}
      <section className="border border-gray-200 rounded p-4 space-y-2 text-sm">
        <h2 className="font-medium text-gray-700 mb-2">Details</h2>
        <Row label="Title" value={book.title} />
        <Row label="Author" value={book.author} />
        <Row label="Publisher" value={book.publisher ?? '—'} />
        <Row label="ISBN" value={book.isbn ?? '—'} />
        <Row label="Condition" value={book.condition} />
        <Row label="Status" value={book.status} />
        <Row label="Acquisition Cost" value={fmt(book.acquisition_cost)} />
        <Row label="Acquisition Date" value={fmtDate(book.acquisition_date)} />
        <Row label="Listing Price" value={fmt(book.listing_price)} />
        <Row label="Platforms" value={book.platforms.length > 0 ? book.platforms.join(', ') : '—'} />
        {book.status === 'Sold' || book.sale_price !== null ? (
          <>
            <Row label="Sale Price" value={fmt(book.sale_price)} />
            <Row label="Sale Platform" value={book.sale_platform ?? '—'} />
            <Row label="Sale Date" value={fmtDate(book.sale_date)} />
          </>
        ) : null}
        {book.status === 'Sold' && book.gross_profit !== null && (
          <Row label="Gross Profit" value={fmt(book.gross_profit)} highlight />
        )}
      </section>

      {/* Editable section — non-terminal only */}
      {!isTerminal && (
        <section className="border border-gray-200 rounded p-4 space-y-4 text-sm">
          <h2 className="font-medium text-gray-700">Edit Listing</h2>
          <form onSubmit={handlePatch} className="space-y-3">
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
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
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
          <form onSubmit={handleStatusTransition} className="space-y-3">
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
      {book.price_history.length > 0 && (
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
              {book.price_history.map(row => (
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

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-40 text-gray-500 flex-shrink-0">{label}</span>
      <span className={highlight ? 'font-semibold text-green-700' : 'text-gray-900'}>{value}</span>
    </div>
  );
}
