"use client";

interface DashboardData {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
}

interface DashboardProps {
  data: DashboardData;
}

export default function Dashboard({ data }: DashboardProps) {
  const formatCurrency = (cents: number): string => {
    return (cents / 100).toFixed(2);
  };

  const conditionOrder = ["Poor", "Acceptable", "Good", "Very Good", "Like New"];
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

      {/* By Condition */}
      <div className="rounded border border-gray-300 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">By Condition</h2>
        <dl className="space-y-2">
          {conditionOrder.map((condition) => (
            <div key={condition} className="flex justify-between text-sm">
              <dt className="text-gray-600">{condition}</dt>
              <dd className="font-medium text-gray-900">{data.by_condition[condition]}</dd>
            </div>
          ))}
        </dl>
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
