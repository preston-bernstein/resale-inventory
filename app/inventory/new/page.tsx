'use client';

import { useEffect, useState, type ComponentType } from 'react';
import AddBookForm from '@/components/AddBookForm';
import AddClothingForm from '@/components/AddClothingForm';
import AddElectronicsForm from '@/components/AddElectronicsForm';
import PresaleTour, { isTourCompleted } from '@/components/tour/PresaleTour';
import type { Category } from '@/lib/constants';

const CATEGORY_TABS: Array<{ category: Category; label: string }> = [
  { category: 'book', label: 'Book' },
  { category: 'clothing', label: 'Clothing' },
  { category: 'electronics', label: 'Electronics' },
];

const FORM_FOR_CATEGORY: Record<Category, ComponentType> = {
  book: AddBookForm,
  clothing: AddClothingForm,
  electronics: AddElectronicsForm,
};

function CategoryTabs({
  category,
  onChange,
}: {
  category: Category;
  onChange: (category: Category) => void;
}) {
  return (
    <div className="inline-flex rounded border border-gray-300 dark:border-gray-700 overflow-hidden mb-6">
      {CATEGORY_TABS.map((tab, index) => (
        <button
          key={tab.category}
          type="button"
          onClick={() => onChange(tab.category)}
          className={`px-4 py-2 text-sm ${index > 0 ? 'border-l border-gray-300 dark:border-gray-700 ' : ''}${
            category === tab.category
              ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
              : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

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
  }, [category]);

  const CategoryForm = FORM_FOR_CATEGORY[category];

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

      <CategoryTabs category={category} onChange={setCategory} />

      <CategoryForm />

      <PresaleTour category={category} open={tourOpen} onOpenChange={setTourOpen} />
    </div>
  );
}
