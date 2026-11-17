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
import { LABEL_CLASS, TextField, useFieldValues } from './FormField';
import { assignTrimmed } from './formBody';

interface BookValues {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  condition: string;
  acquisitionCost: string;
  acquisitionDate: string;
}

const INITIAL_VALUES: BookValues = {
  isbn: '',
  title: '',
  author: '',
  publisher: '',
  condition: 'Good',
  acquisitionCost: '',
  acquisitionDate: '',
};

/** The message to show for a checksum-invalid ISBN, or null when the ISBN passes. */
function isbnChecksumMessage(isbn: string): string | null {
  const checksumResult = validateIsbnChecksum(isbn);
  if (checksumResult.valid) return null;
  return checksumResult.reason === 'shape'
    ? 'Invalid ISBN format.'
    : "ISBN checksum doesn't match — check the last digit.";
}

function buildBookBody(values: BookValues, costCents: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    category: 'book',
    title: values.title.trim(),
    author: values.author.trim(),
    condition: values.condition,
    acquisition_cost: costCents,
    acquisition_date: values.acquisitionDate,
  };
  assignTrimmed(body, 'isbn', values.isbn);
  assignTrimmed(body, 'publisher', values.publisher);
  return body;
}

interface BookDetailFieldsProps {
  values: BookValues;
  setValue: (key: keyof BookValues, value: string) => void;
  errors: Record<string, string>;
}

interface IsbnDetails {
  title?: string;
  author?: string;
  publisher?: string;
}

// Autocomplete suggestion lists — fetched once from the operator's own past
// entries. This is a fallback for when ISBN lookup fails, isn't used, or the
// operator wants to see their own past entries.
function useAuthorAndPublisherOptions() {
  const [authorOptions, setAuthorOptions] = useState<string[]>([]);
  const [publisherOptions, setPublisherOptions] = useState<string[]>([]);

  useEffect(() => {
    // fetchFieldSuggestions swallows its own errors and resolves to [] on
    // failure — it never rejects — so `.then()` alone is complete handling;
    // `void` just satisfies the linter's static (can't-see-that) analysis.
    void fetchFieldSuggestions('author').then(setAuthorOptions);
    void fetchFieldSuggestions('publisher').then(setPublisherOptions);
  }, []);

  return { authorOptions, publisherOptions };
}

function useIsbnLookup(isbn: string, onFound: (details: IsbnDetails) => void) {
  const [isbnLookupMsg, setIsbnLookupMsg] = useState('');
  const [isbnLoading, setIsbnLoading] = useState(false);
  const [isbnChecksumError, setIsbnChecksumError] = useState('');

  async function lookupIsbn() {
    const trimmed = isbn.trim();
    if (!trimmed) return;

    const checksumMessage = isbnChecksumMessage(trimmed);
    if (checksumMessage) {
      setIsbnLookupMsg('');
      setIsbnChecksumError(checksumMessage);
      return;
    }
    setIsbnChecksumError('');

    setIsbnLoading(true);
    setIsbnLookupMsg('');
    try {
      const res = await fetch(`/api/isbn/${encodeURIComponent(trimmed)}`);
      if (res.ok) {
        onFound(await res.json());
        setIsbnLookupMsg('ISBN found — fields pre-filled.');
      } else {
        setIsbnLookupMsg('Not found — enter manually.');
      }
    } catch (err) {
      console.error('ISBN lookup failed:', err);
      setIsbnLookupMsg('Lookup failed — enter manually.');
    } finally {
      setIsbnLoading(false);
    }
  }

  // Enter-to-submit from within the ISBN field fires the form's submit
  // event directly, without a blur — bypassing lookupIsbn()'s checksum
  // check entirely. Re-check here so a checksum-invalid ISBN can never
  // reach the server this way (where a 422's `fields: ['isbn']` array
  // wouldn't render through fieldErrors, an object keyed by field name).
  function isIsbnValidForSubmit(): boolean {
    const trimmedIsbn = isbn.trim();
    const checksumMessage = trimmedIsbn ? isbnChecksumMessage(trimmedIsbn) : null;
    if (checksumMessage) setIsbnChecksumError(checksumMessage);
    return !checksumMessage;
  }

  return { isbnLookupMsg, isbnLoading, isbnChecksumError, lookupIsbn, isIsbnValidForSubmit };
}

interface IsbnFieldProps {
  value: string;
  onChange: (value: string) => void;
  onLookup: () => void;
  loading: boolean;
  message: string;
  error?: string;
}

function IsbnField({ value, onChange, onLookup, loading, message, error }: IsbnFieldProps) {
  const isWarning = message.startsWith('Not') || message.startsWith('Lookup');

  return (
    <div data-tour={BOOK_ANCHORS.isbn}>
      <label className={LABEL_CLASS}>ISBN</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={onLookup}
          placeholder="e.g. 9780735224292"
          className="flex-1 border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <button
          type="button"
          onClick={onLookup}
          disabled={loading}
          className="border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      {message && (
        <p className={`text-xs mt-1 ${isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}>
          {message}
        </p>
      )}
      <FieldError message={error} />
    </div>
  );
}

function BookDetailFields({ values, setValue, errors }: BookDetailFieldsProps) {
  const { authorOptions, publisherOptions } = useAuthorAndPublisherOptions();

  return (
    <>
      <TextField
        label="Title *"
        required={true}
        tourAnchor={BOOK_ANCHORS.title}
        value={values.title}
        onChange={(value) => setValue('title', value)}
        error={errors.title}
      />

      <TextField
        label="Author *"
        required={true}
        tourAnchor={BOOK_ANCHORS.author}
        value={values.author}
        onChange={(value) => setValue('author', value)}
        error={errors.author}
        suggestions={{ listId: 'author-options', options: authorOptions }}
      />

      <TextField
        label="Publisher"
        value={values.publisher}
        onChange={(value) => setValue('publisher', value)}
        suggestions={{ listId: 'publisher-options', options: publisherOptions }}
      />
    </>
  );
}

function BookAcquisitionFields({ values, setValue, errors }: BookDetailFieldsProps) {
  return (
    <>
      <div data-tour={BOOK_ANCHORS.condition}>
        <ConditionSelect
          conditions={BOOK_CONDITIONS}
          value={values.condition}
          onChange={(value) => setValue('condition', value)}
          error={errors.condition}
        />
      </div>

      <div data-tour={BOOK_ANCHORS.acquisition}>
        <AcquisitionFields
          cost={values.acquisitionCost}
          onCostChange={(value) => setValue('acquisitionCost', value)}
          costError={errors.acquisition_cost}
          date={values.acquisitionDate}
          onDateChange={(value) => setValue('acquisitionDate', value)}
          dateError={errors.acquisition_date}
        />
      </div>
    </>
  );
}

export default function AddBookForm() {
  const [values, setValue] = useFieldValues(INITIAL_VALUES);
  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  const isbnLookup = useIsbnLookup(values.isbn, (found) => {
    setValue('title', found.title ?? '');
    setValue('author', found.author ?? '');
    setValue('publisher', found.publisher ?? '');
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isbnLookup.isIsbnValidForSubmit()) return;

    await submit({
      acquisitionCost: values.acquisitionCost,
      buildBody: (costCents) => buildBookBody(values, costCents),
    });
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5 max-w-lg">
      <IsbnField
        value={values.isbn}
        onChange={(value) => setValue('isbn', value)}
        onLookup={() => { void isbnLookup.lookupIsbn(); }}
        loading={isbnLookup.isbnLoading}
        message={isbnLookup.isbnLookupMsg}
        error={isbnLookup.isbnChecksumError || fieldErrors.isbn}
      />

      <BookDetailFields values={values} setValue={setValue} errors={fieldErrors} />

      <BookAcquisitionFields values={values} setValue={setValue} errors={fieldErrors} />

      <SubmitError message={submitError} />

      <div data-tour={BOOK_ANCHORS.submit}>
        <SubmitButton loading={submitLoading} label="Add Book" />
      </div>
    </form>
  );
}
