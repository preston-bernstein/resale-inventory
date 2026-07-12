import Link from "next/link";
import Dashboard from "@/components/Dashboard";
import { getDashboardData } from "@/lib/dashboard";

export default async function DashboardPage() {
  const data = getDashboardData();

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
