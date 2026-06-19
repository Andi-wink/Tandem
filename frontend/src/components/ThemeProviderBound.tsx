'use client';

import { ThemeProvider } from 'next-themes';

export function ThemeProviderBound({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      storageKey="tandem-theme"
      enableSystem={false}
    >
      {children}
    </ThemeProvider>
  );
}
