import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import { getDashboardData } from "@/lib/dashboard";
import { resolveSession } from "@/lib/tenantAuth";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

export default async function DashboardPage() {
  const rawToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = rawToken ? resolveSession(rawToken) : null;
  if (!session) {
    redirect("/login");
  }

  const data = getDashboardData(session.tenantId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <Link
          href="/dashboard"
          className="rounded bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-4 py-2 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors"
        >
          Refresh
        </Link>
      </div>
      <Dashboard data={data} />
    </div>
  );
}
