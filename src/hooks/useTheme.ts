/**
 * Light/dark theme: persisted choice, defaulting to the OS preference.
 * Toggles the `dark` class on <html> (Tailwind class-based dark variant).
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export function useTheme(persisted: Theme | undefined): {
  theme: Theme;
  toggleTheme: () => void;
} {
  const [theme, setTheme] = useState<Theme>(() => {
    if (persisted === 'light' || persisted === 'dark') return persisted;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggleTheme };
}

/** Honors the user's reduced-motion preference (construction replay, transitions). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
