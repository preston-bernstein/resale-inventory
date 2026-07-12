import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resale Inventory",
  description: "Track your book and clothing resale inventory",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#111827",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900">
        <header className="border-b border-gray-200 bg-white">
          <nav className="mx-auto max-w-5xl flex items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-semibold text-gray-900 hover:text-gray-700">
              Resale Inventory
            </Link>
            <Link href="/inventory" className="text-sm text-gray-600 hover:text-gray-900">
              Inventory
            </Link>
            <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
              Dashboard
            </Link>
            <Link href="/playbook" className="text-sm text-gray-600 hover:text-gray-900">
              Playbook
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
