'use client';

import { useState } from 'react';
import AddBookForm from '@/components/AddBookForm';
import AddClothingForm from '@/components/AddClothingForm';
import type { Category } from '@/lib/constants';

export default function AddItemPage() {
  const [category, setCategory] = useState<Category>('book');

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">Add Item</h1>

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
    </div>
  );
}
