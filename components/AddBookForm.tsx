'use client';

import { useEffect, useState } from 'react';
import { BOOK_CONDITIONS } from '@/lib/constants';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { useSubmitItemForm } from './useSubmitItemForm';
import { ConditionSelect } from './ConditionSelect';
import { AcquisitionFields } from './AcquisitionFields';
import { SubmitButton } from './SubmitButton';
import { SubmitError } from './SubmitError';
import { FieldError } from './FieldError';

export default function AddBookForm() {
  const [isbn, setIsbn] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [publisher, setPublisher] = useState('');
  const [condition, setCondition] = useState<string>('Good');
  const [acquisitionCost, setAcquisitionCost] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');

  const [isbnLookupMsg, setIsbnLookupMsg] = useState('');
  const [isbnLoading, setIsbnLoading] = useState(false);

  // Autocomplete suggestion lists — fetched once from the operator's own
  // past entries. This is a fallback for when ISBN lookup fails, isn't
  // used, or the operator wants to see their own past entries.
  const [authorOptions, setAuthorOptions] = useState<string[]>([]);
  const [publisherOptions, setPublisherOptions] = useState<string[]>([]);

  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  useEffect(() => {
    // fetchFieldSuggestions swallows its own errors and resolves to [] on
    // failure — it never rejects — so `.then()` alone is complete handling;
    // `void` just satisfies the linter's static (can't-see-that) analysis.
    void fetchFieldSuggestions('author').then(setAuthorOptions);
    void fetchFieldSuggestions('publisher').then(setPublisherOptions);
  }, []);

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
    await submit({
      acquisitionCost,
      buildBody: (costCents) => {
        const body: Record<string, unknown> = {
          category: 'book',
          title: title.trim(),
          author: author.trim(),
          condition,
          acquisition_cost: costCents,
          acquisition_date: acquisitionDate,
        };
        if (isbn.trim()) body.isbn = isbn.trim();
        if (publisher.trim()) body.publisher = publisher.trim();
        return body;
      },
    });
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5 max-w-lg">
      {/* ISBN */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">ISBN</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={isbn}
            onChange={e => setIsbn(e.target.value)}
            onBlur={() => { void lookupIsbn(); }}
            placeholder="e.g. 9780735224292"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
          <button
            type="button"
            onClick={() => { void lookupIsbn(); }}
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
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Author */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Author *</label>
        <input
          type="text"
          required
          list="author-options"
          value={author}
          onChange={e => setAuthor(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="author-options">
          {authorOptions.map(a => <option key={a} value={a} />)}
        </datalist>
        <FieldError message={fieldErrors.author} />
      </div>

      {/* Publisher */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Publisher</label>
        <input
          type="text"
          list="publisher-options"
          value={publisher}
          onChange={e => setPublisher(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="publisher-options">
          {publisherOptions.map(p => <option key={p} value={p} />)}
        </datalist>
      </div>

      <ConditionSelect
        conditions={BOOK_CONDITIONS}
        value={condition}
        onChange={setCondition}
        error={fieldErrors.condition}
      />

      <AcquisitionFields
        cost={acquisitionCost}
        onCostChange={setAcquisitionCost}
        costError={fieldErrors.acquisition_cost}
        date={acquisitionDate}
        onDateChange={setAcquisitionDate}
        dateError={fieldErrors.acquisition_date}
      />

      <SubmitError message={submitError} />

      <SubmitButton loading={submitLoading} label="Add Book" />
    </form>
  );
}
