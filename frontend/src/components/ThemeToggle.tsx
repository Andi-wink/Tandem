'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';

export function ThemeToggle({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Sync native window title bar theme with app theme
  useEffect(() => {
    if (!mounted) return;
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().setTheme(theme === 'light' ? 'light' : 'dark').catch(() => {});
    }).catch(() => {});
  }, [theme, mounted]);

  if (!mounted) return null;

  const isDark = theme === 'dark';

  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={`flex items-center justify-center rounded-lg transition-colors hover:bg-accent ${
        isCollapsed ? 'p-2' : 'w-full px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
      }`}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        <>
          <Sun className="w-4 h-4" />
          {!isCollapsed && <span className="ml-2">Light Mode</span>}
        </>
      ) : (
        <>
          <Moon className="w-4 h-4" />
          {!isCollapsed && <span className="ml-2">Dark Mode</span>}
        </>
      )}
    </button>
  );
}
