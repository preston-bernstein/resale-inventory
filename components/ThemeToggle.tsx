'use client';

import { useEffect, useState } from 'react';

// Renders null until mounted so the server-rendered markup (which can't
// know the user's stored preference) never mismatches the client — the
// inline no-flash script in layout.tsx already set the correct theme
// before first paint, this only needs to catch its icon up to match.
export default function ThemeToggle() {
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="text-sm px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400"
    >
      {isDark === null ? null : isDark ? '☀️' : '🌙'}
    </button>
  );
}
