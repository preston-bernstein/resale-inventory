'use client';

import { useEffect, useState } from 'react';
import { BOOK_CONDITIONS } from '@/lib/constants';
import { BOOK_ANCHORS } from '@/lib/tourAnchors';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { validateIsbnChecksum } from '@/lib/isbn';
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
  const [isbnChecksumError, setIsbnChecksumError] = useState('');

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

    const checksumResult = validateIsbnChecksum(trimmed);
    if (!checksumResult.valid) {
      setIsbnLookupMsg('');
      setIsbnChecksumError(
        checksumResult.reason === 'shape'
          ? 'Invalid ISBN format.'
          : "ISBN checksum doesn't match — check the last digit."
      );
      return;
    }
    setIsbnChecksumError('');

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

    // Enter-to-submit from within the ISBN field fires the form's submit
    // event directly, without a blur — bypassing lookupIsbn()'s checksum
    // check entirely. Re-check here so a checksum-invalid ISBN can never
    // reach the server this way (where a 422's `fields: ['isbn']` array
    // wouldn't render through fieldErrors, an object keyed by field name).
    const trimmedIsbn = isbn.trim();
    if (trimmedIsbn) {
      const checksumResult = validateIsbnChecksum(trimmedIsbn);
      if (!checksumResult.valid) {
        setIsbnChecksumError(
          checksumResult.reason === 'shape'
            ? 'Invalid ISBN format.'
            : "ISBN checksum doesn't match — check the last digit."
        );
        return;
      }
    }

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
      <div data-tour={BOOK_ANCHORS.isbn}>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">ISBN</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={isbn}
            onChange={e => setIsbn(e.target.value)}
            onBlur={() => { void lookupIsbn(); }}
            placeholder="e.g. 9780735224292"
            className="flex-1 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <button
            type="button"
            onClick={() => { void lookupIsbn(); }}
            disabled={isbnLoading}
            className="border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {isbnLoading ? 'Looking up…' : 'Look up'}
          </button>
        </div>
        {isbnLookupMsg && (
          <p className={`text-xs mt-1 ${isbnLookupMsg.startsWith('Not') || isbnLookupMsg.startsWith('Lookup') ? 'text-amber-600 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
            {isbnLookupMsg}
          </p>
        )}
        <FieldError message={isbnChecksumError || fieldErrors.isbn} />
      </div>

      {/* Title */}
      <div data-tour={BOOK_ANCHORS.title}>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title *</label>
        <input
          type="text"
          required
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Author */}
      <div data-tour={BOOK_ANCHORS.author}>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Author *</label>
        <input
          type="text"
          required
          list="author-options"
          value={author}
          onChange={e => setAuthor(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <datalist id="author-options">
          {authorOptions.map(a => <option key={a} value={a} />)}
        </datalist>
        <FieldError message={fieldErrors.author} />
      </div>

      {/* Publisher */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Publisher</label>
        <input
          type="text"
          list="publisher-options"
          value={publisher}
          onChange={e => setPublisher(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <datalist id="publisher-options">
          {publisherOptions.map(p => <option key={p} value={p} />)}
        </datalist>
      </div>

      <div data-tour={BOOK_ANCHORS.condition}>
        <ConditionSelect
          conditions={BOOK_CONDITIONS}
          value={condition}
          onChange={setCondition}
          error={fieldErrors.condition}
        />
      </div>

      <div data-tour={BOOK_ANCHORS.acquisition}>
        <AcquisitionFields
          cost={acquisitionCost}
          onCostChange={setAcquisitionCost}
          costError={fieldErrors.acquisition_cost}
          date={acquisitionDate}
          onDateChange={setAcquisitionDate}
          dateError={fieldErrors.acquisition_date}
        />
      </div>

      <SubmitError message={submitError} />

      <div data-tour={BOOK_ANCHORS.submit}>
        <SubmitButton loading={submitLoading} label="Add Book" />
      </div>
    </form>
  );
}
