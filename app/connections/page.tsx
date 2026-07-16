import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ConnectionsView from "@/components/connections/ConnectionsView";
import { resolveSession } from "@/lib/tenantAuth";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

export default async function ConnectionsPage() {
  const rawToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = rawToken ? resolveSession(rawToken) : null;
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Connections</h1>
      </div>
      <ConnectionsView tenantId={session.tenantId} />
    </div>
  );
}
