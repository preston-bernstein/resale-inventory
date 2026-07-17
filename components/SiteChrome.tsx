'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';

// Renders the app's global header/nav everywhere EXCEPT /phone/* routes.
// The phone-handoff page is a dead-end, chrome-free view for a helper's
// phone browser — it must not expose links back into the main app (req 9).
// app/layout.tsx is a Server Component and can't call usePathname() itself,
// so this client component owns the conditional.
export default function SiteChrome() {
  const pathname = usePathname();
  if (pathname?.startsWith('/phone')) return null;

  return (
    <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
      <nav className="mx-auto max-w-5xl flex items-center gap-6 px-4 py-3">
        <Link href="/" className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-gray-700 dark:hover:text-gray-300">
          Resale Inventory
        </Link>
        <Link href="/inventory" className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
          Inventory
        </Link>
        <Link href="/dashboard" className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
          Dashboard
        </Link>
        <Link href="/playbook" className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
          Playbook
        </Link>
        <Link href="/connections" className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
          Connections
        </Link>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
