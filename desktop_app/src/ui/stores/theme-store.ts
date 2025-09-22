import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light' | 'system';

interface ThemeState {
  theme: Theme;
}

interface ThemeActions {
  setTheme: (theme: Theme) => void;
}

type ThemeStore = ThemeState & ThemeActions;

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'vite-ui-theme',
    }
  )
);

// Effect to apply theme to DOM
if (typeof window !== 'undefined') {
  const applyTheme = (theme: Theme) => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  };

  // Apply theme on initial load
  const currentTheme = useThemeStore.getState().theme;
  applyTheme(currentTheme);

  // Subscribe to theme changes
  useThemeStore.subscribe((state) => {
    applyTheme(state.theme);
  });
}
