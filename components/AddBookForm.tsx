'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CONDITIONS } from '@/lib/constants';

interface FieldErrors {
  [key: string]: string;
}

export default function AddBookForm() {
  const router = useRouter();

  const [isbn, setIsbn] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [publisher, setPublisher] = useState('');
  const [condition, setCondition] = useState<string>('Good');
  const [acquisitionCost, setAcquisitionCost] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');

  const [isbnLookupMsg, setIsbnLookupMsg] = useState('');
  const [isbnLoading, setIsbnLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState('');

  async function lookupIsbn() {
    const trimmed = isbn.trim();
    if (!trimmed) return;
    setIsbnLoading(true);
    setIsbnLookupMsg('');
    try {
      const res = await fetch(`/api/isbn/${encodeURIComponent(trimmed)}`);
      if (res.ok) {
        const data = await res.json();
        setTitle(data.title ?? '');
        setAuthor(data.author ?? '');
        setPublisher(data.publisher ?? '');
        setIsbnLookupMsg('ISBN found — fields pre-filled.');
      } else {
        setIsbnLookupMsg('Not found — enter manually.');
      }
    } catch {
      setIsbnLookupMsg('Lookup failed — enter manually.');
    } finally {
      setIsbnLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setSubmitError('');
    setSubmitLoading(true);

    const costCents = Math.round(parseFloat(acquisitionCost) * 100);
    if (isNaN(costCents)) {
      setFieldErrors({ acquisition_cost: 'Enter a valid dollar amount.' });
      setSubmitLoading(false);
      return;
    }

    const body: Record<string, unknown> = {
      title: title.trim(),
      author: author.trim(),
      condition,
      acquisition_cost: costCents,
      acquisition_date: acquisitionDate,
    };
    if (isbn.trim()) body.isbn = isbn.trim();
    if (publisher.trim()) body.publisher = publisher.trim();

    try {
      const res = await fetch('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 201) {
        router.push('/books');
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && data.fields) {
        setFieldErrors(data.fields);
      } else {
        setSubmitError(data.error ?? 'Submission failed.');
      }
    } catch {
      setSubmitError('Network error — please try again.');
    } finally {
      setSubmitLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      {/* ISBN */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">ISBN</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={isbn}
            onChange={e => setIsbn(e.target.value)}
            onBlur={lookupIsbn}
            placeholder="e.g. 9780735224292"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
          <button
            type="button"
            onClick={lookupIsbn}
            disabled={isbnLoading}
            className="border border-gray-300 rounded px-3 py-2 text-sm bg-gray-50 hover:bg-gray-100 disabled:opacity-50"
          >
            {isbnLoading ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        {isbnLookupMsg && (
          <p className={`text-xs mt-1 ${isbnLookupMsg.startsWith('Not') || isbnLookupMsg.startsWith('Lookup') ? 'text-amber-600' : 'text-green-700'}`}>
            {isbnLookupMsg}
          </p>
        )}
      </div>

      {/* Title */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
        <input
          type="text"
          required
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        {fieldErrors.title && <p className="text-xs text-red-600 mt-1">{fieldErrors.title}</p>}
      </div>

      {/* Author */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Author *</label>
        <input
          type="text"
          required
          value={author}
          onChange={e => setAuthor(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        {fieldErrors.author && <p className="text-xs text-red-600 mt-1">{fieldErrors.author}</p>}
      </div>

      {/* Publisher */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Publisher</label>
        <input
          type="text"
          value={publisher}
          onChange={e => setPublisher(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
      </div>

      {/* Condition */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Condition *</label>
        <select
          required
          value={condition}
          onChange={e => setCondition(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        >
          {CONDITIONS.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {fieldErrors.condition && <p className="text-xs text-red-600 mt-1">{fieldErrors.condition}</p>}
      </div>

      {/* Acquisition Cost */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Cost (USD) *</label>
        <input
          type="number"
          required
          min="0"
          step="0.01"
          value={acquisitionCost}
          onChange={e => setAcquisitionCost(e.target.value)}
          placeholder="0.00"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        {fieldErrors.acquisition_cost && <p className="text-xs text-red-600 mt-1">{fieldErrors.acquisition_cost}</p>}
      </div>

      {/* Acquisition Date */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Acquisition Date *</label>
        <input
          type="date"
          required
          value={acquisitionDate}
          onChange={e => setAcquisitionDate(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        {fieldErrors.acquisition_date && <p className="text-xs text-red-600 mt-1">{fieldErrors.acquisition_date}</p>}
      </div>

      {submitError && (
        <p className="text-sm text-red-600 border border-red-200 rounded px-3 py-2 bg-red-50">{submitError}</p>
      )}

      <button
        type="submit"
        disabled={submitLoading}
        className="w-full bg-gray-900 text-white rounded px-4 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
      >
        {submitLoading ? 'Adding…' : 'Add Book'}
      </button>
    </form>
  );
}
