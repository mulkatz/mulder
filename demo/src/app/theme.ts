import { useEffect, useState } from 'react';

const STORAGE_KEY = 'mulder-theme';

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }

    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return {
    theme,
    setTheme,
    toggleTheme() {
      setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
    },
  };
}
