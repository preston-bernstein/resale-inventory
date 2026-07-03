import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book Inventory",
  description: "Track your used book collection",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900">
        <header className="border-b border-gray-200 bg-white">
          <nav className="mx-auto max-w-5xl flex items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-semibold text-gray-900 hover:text-gray-700">
              Book Inventory
            </Link>
            <Link href="/books" className="text-sm text-gray-600 hover:text-gray-900">
              Books
            </Link>
            <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
              Dashboard
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
