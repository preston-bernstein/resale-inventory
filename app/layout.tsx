import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resale Inventory",
  description: "Track your book and clothing resale inventory",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#111827",
};

// Runs before hydration so the correct theme class is on <html> for the
// very first paint — without this, a dark-mode user would see a flash of
// the light theme on every load (the standard "no-flash" dark-mode script
// pattern; must stay a plain inline script, not a React effect, since
// effects only run after the initial paint).
const NO_FLASH_THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
        {/* Visually hidden until focused — lets keyboard users jump past
            the repeated nav straight to page content (WCAG 2.4.1). */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded focus:bg-gray-900 focus:text-white dark:focus:bg-white dark:focus:text-gray-900"
        >
          Skip to main content
        </a>
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
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </nav>
        </header>
        <main id="main-content" className="mx-auto max-w-5xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
