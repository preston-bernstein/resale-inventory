import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-8 text-center">
      <div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-3">Resale Inventory</h1>
        <p className="text-lg text-gray-500 dark:text-gray-400">Track your book and clothing resale inventory</p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/inventory"
          className="rounded bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-6 py-2 text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors"
        >
          View Inventory
        </Link>
        <Link
          href="/dashboard"
          className="rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 px-6 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
