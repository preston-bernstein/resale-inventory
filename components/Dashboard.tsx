"use client";

import { BOOK_CONDITIONS, CLOTHING_CONDITIONS } from '@/lib/constants';

interface DashboardData {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
  by_category: {
    book: { count: number; acquisition_cost: number };
    clothing: { count: number; acquisition_cost: number };
  };
}

interface DashboardProps {
  data: DashboardData;
}

export default function Dashboard({ data }: DashboardProps) {
  const formatCurrency = (cents: number): string => {
    return (cents / 100).toFixed(2);
  };

  const bookConditionOrder = BOOK_CONDITIONS;
  const clothingConditionOrder = CLOTHING_CONDITIONS;
  const statusOrder = ["Unlisted", "Listed", "Sale Pending", "Sold", "Removed", "Donated", "Discarded"];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded border border-gray-300 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-600 mb-2">Items Held</h2>
          <p className="text-3xl font-bold text-gray-900">{data.held_count}</p>
        </div>
        <div className="rounded border border-gray-300 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-600 mb-2">
            Acquisition Cost (Held)
          </h2>
          <p className="text-3xl font-bold text-gray-900">
            ${formatCurrency(data.held_acquisition_cost)}
          </p>
        </div>
      </div>

      {/* By Category */}
      <div className="rounded border border-gray-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">By Category</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Books</h3>
            <dl className="space-y-2">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-600">Count</dt>
                <dd className="font-medium text-gray-900">{data.by_category.book.count}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-600">Acquisition Cost</dt>
                <dd className="font-medium text-gray-900">
                  ${formatCurrency(data.by_category.book.acquisition_cost)}
                </dd>
              </div>
            </dl>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Clothing</h3>
            <dl className="space-y-2">
              <div className="flex justify-between text-sm">
                <dt className="text-gray-600">Count</dt>
                <dd className="font-medium text-gray-900">{data.by_category.clothing.count}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-gray-600">Acquisition Cost</dt>
                <dd className="font-medium text-gray-900">
                  ${formatCurrency(data.by_category.clothing.acquisition_cost)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {/* By Condition */}
      <div className="rounded border border-gray-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">By Condition</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Books</h3>
            <dl className="space-y-2">
              {bookConditionOrder.map((condition) => (
                <div key={condition} className="flex justify-between text-sm">
                  <dt className="text-gray-600">{condition}</dt>
                  <dd className="font-medium text-gray-900">{data.by_condition[condition]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Clothing</h3>
            <dl className="space-y-2">
              {clothingConditionOrder.map((condition) => (
                <div key={condition} className="flex justify-between text-sm">
                  <dt className="text-gray-600">{condition}</dt>
                  <dd className="font-medium text-gray-900">{data.by_condition[condition]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>

      {/* By Status */}
      <div className="rounded border border-gray-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">By Status</h2>
        <dl className="space-y-2">
          {statusOrder.map((status) => (
            <div key={status} className="flex justify-between text-sm">
              <dt className="text-gray-600">{status}</dt>
              <dd className="font-medium text-gray-900">{data.by_status[status]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
