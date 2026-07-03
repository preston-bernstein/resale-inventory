import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-8 text-center">
      <div>
        <h1 className="text-4xl font-bold text-gray-900 mb-3">Book Inventory</h1>
        <p className="text-lg text-gray-500">Track your used book collection</p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/books"
          className="rounded bg-gray-900 text-white px-6 py-2 text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          View Inventory
        </Link>
        <Link
          href="/dashboard"
          className="rounded border border-gray-300 text-gray-700 px-6 py-2 text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
