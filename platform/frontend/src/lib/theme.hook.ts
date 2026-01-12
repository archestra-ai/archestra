import { DEFAULT_THEME_ID, type OrganizationTheme } from "@shared";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePublicAppearance } from "./appearance.query";
import { useUpdateOrganization } from "./organization.query";

const THEME_STORAGE_KEY = "archestra-theme";
const DEFAULT_THEME: OrganizationTheme = DEFAULT_THEME_ID as OrganizationTheme;

export function useOrgTheme() {
  const pathname = usePathname();

  // Check if we're on an auth page (login, signup, etc.)
  const isAuthPage = pathname?.startsWith("/auth/");

  // Always use public appearance endpoint - it returns the same data for all pages
  // and works without authentication
  const { data: appearance, isLoading: isLoadingAppearance } =
    usePublicAppearance();

  const { theme: themeFromBackend, logo } = appearance ?? {};

  const updateThemeMutation = useUpdateOrganization(
    "Appearance settings updated",
    "Failed to update appearance settings",
  );

  const themeFromLocalStorage =
    typeof window !== "undefined"
      ? (localStorage.getItem(THEME_STORAGE_KEY) as OrganizationTheme | null)
      : null;

  const [currentUITheme, setCurrentUITheme] = useState<OrganizationTheme>(
    themeFromBackend || themeFromLocalStorage || DEFAULT_THEME,
  );

  const saveAppearance = useCallback(
    (themeId: OrganizationTheme) => {
      setCurrentUITheme(themeId);
      updateThemeMutation.mutate({
        theme: themeId,
      });
      applyThemeInLocalStorage(themeId);
    },
    [updateThemeMutation],
  );

  // whenever currentUITheme changes, apply the theme on the UI
  // Font is automatically applied via CSS --font-sans variable in the theme class
  useEffect(() => {
    applyThemeOnUI(currentUITheme);
  }, [currentUITheme]);

  // whenever themeFromBackend is loaded and is different from themeFromLocalStorage, update local storage and UI
  // Only sync after actual data loads (not during placeholder loading) to prevent flicker
  useEffect(() => {
    if (
      !isLoadingAppearance &&
      themeFromBackend &&
      themeFromBackend !== themeFromLocalStorage
    ) {
      applyThemeInLocalStorage(themeFromBackend);
      setCurrentUITheme(themeFromBackend);
    }
  }, [themeFromBackend, themeFromLocalStorage, isLoadingAppearance]);

  // For auth pages, return limited data (read-only appearance, no update functions)
  if (isAuthPage) {
    return {
      currentUITheme: currentUITheme || DEFAULT_THEME,
      themeFromBackend,
      setPreviewTheme: undefined,
      saveAppearance: undefined,
      logo,
      DEFAULT_THEME,
      isLoadingAppearance,
      applyThemeOnUI,
    };
  }

  return {
    currentUITheme: currentUITheme || DEFAULT_THEME,
    themeFromBackend,
    setPreviewTheme: setCurrentUITheme,
    saveAppearance,
    logo,
    DEFAULT_THEME,
    isLoadingAppearance,
    applyThemeOnUI,
  };
}

const applyThemeOnUI = (themeId: OrganizationTheme) => {
  const root = document.documentElement;
  const themeClasses = Array.from(root.classList).filter((cls) =>
    cls.startsWith("theme-"),
  );
  for (const cls of themeClasses) {
    root.classList.remove(cls);
  }
  root.classList.add(`theme-${themeId}`);
};

const applyThemeInLocalStorage = (themeId: OrganizationTheme) => {
  localStorage.setItem(THEME_STORAGE_KEY, themeId);
};
