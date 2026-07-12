'use client';

import { useEffect, useState } from 'react';
import AddBookForm from '@/components/AddBookForm';
import AddClothingForm from '@/components/AddClothingForm';
import PresaleTour, { isTourCompleted } from '@/components/tour/PresaleTour';
import type { Category } from '@/lib/constants';

export default function AddItemPage() {
  const [category, setCategory] = useState<Category>('book');
  const [tourOpen, setTourOpen] = useState(false);
  const [tourCompleted, setTourCompleted] = useState(false);

  // localStorage is only available client-side; reading it synchronously
  // during render would risk an SSR/client hydration mismatch. Compute the
  // completion state in an effect keyed on `category` instead.
  useEffect(() => {
    setTourCompleted(isTourCompleted(category));
  }, [category]);

  // Auto-close the tour if the category changes while it's open, without
  // listing `tourOpen` as a dependency (which would re-fire this effect on
  // every open/close and risk a loop).
  useEffect(() => {
    setTourOpen((currentlyOpen) => (currentlyOpen ? false : currentlyOpen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Add Item</h1>
        <button
          type="button"
          onClick={() => setTourOpen(true)}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          {tourCompleted ? 'Retake the tour' : 'Take the tour'}
        </button>
      </div>

      <div className="inline-flex rounded border border-gray-300 dark:border-gray-700 overflow-hidden mb-6">
        <button
          type="button"
          onClick={() => setCategory('book')}
          className={`px-4 py-2 text-sm ${
            category === 'book'
              ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
              : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          Book
        </button>
        <button
          type="button"
          onClick={() => setCategory('clothing')}
          className={`px-4 py-2 text-sm border-l border-gray-300 dark:border-gray-700 ${
            category === 'clothing'
              ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
              : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          Clothing
        </button>
      </div>

      {category === 'book' ? <AddBookForm /> : <AddClothingForm />}

      <PresaleTour category={category} open={tourOpen} onOpenChange={setTourOpen} />
    </div>
  );
}
