import Link from "next/link";
import Dashboard from "@/components/Dashboard";

interface DashboardData {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
}

export default async function DashboardPage() {
  const response = await fetch("http://localhost:3000/api/dashboard", {
    cache: "no-store",
  });

  if (!response.ok) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600">Failed to load dashboard data</p>
      </div>
    );
  }

  const data: DashboardData = await response.json();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <Link
          href="/dashboard"
          className="rounded bg-gray-900 text-white px-4 py-2 text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          Refresh
        </Link>
      </div>
      <Dashboard data={data} />
    </div>
  );
}
