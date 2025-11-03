import { DEFAULT_THEME_ID, type OrganizationTheme } from "@shared";
import { useEffect, useState } from "react";
import {
  useOrganizationAppearance,
  useUpdateOrganizationAppearance,
} from "./organization.query";

const THEME_STORAGE_KEY = "archestra-theme";
const _FONT_STORAGE_KEY = "archestra-font";
const DEFAULT_THEME: OrganizationTheme = DEFAULT_THEME_ID as OrganizationTheme;

export function useOrgTheme() {
  const { data, isLoading: isLoadingAppearance } = useOrganizationAppearance();
  const {
    theme: themeFromBackend,
    customFont: _fontFromBackend,
    logo,
    logoType,
  } = data ?? {};
  const updateMutation = useUpdateOrganizationAppearance();
  const themeFromLocalStorage =
    typeof window !== "undefined"
      ? (localStorage.getItem(THEME_STORAGE_KEY) as OrganizationTheme | null)
      : null;
  // const fontFromLocalStorage = localStorage.getItem(FONT_STORAGE_KEY);

  const [currentUITheme, setCurrentUITheme] = useState<OrganizationTheme>(
    themeFromLocalStorage || themeFromBackend || DEFAULT_THEME,
  );

  const applyThemeOnBackend = (themeId: OrganizationTheme) => {
    updateMutation.mutate({
      theme: themeId,
    });
  };

  const setPreviewTheme = (themeId: OrganizationTheme) => {
    setCurrentUITheme(themeId);
  };

  const saveTheme = (themeId: OrganizationTheme) => {
    setPreviewTheme(themeId);
    applyThemeOnBackend(themeId);
    applyThemeInLocalStorage(themeId);
  };

  // whenever currentUITheme changes, apply the theme on the UI
  useEffect(() => {
    applyThemeOnUI(currentUITheme);
  }, [currentUITheme]);

  // whenever themeFromBackend is loaded and is different from themeFromLocalStorage, update local storage
  useEffect(() => {
    if (themeFromBackend && themeFromBackend !== themeFromLocalStorage) {
      applyThemeInLocalStorage(themeFromBackend);
    }
  }, [themeFromBackend, themeFromLocalStorage]);

  return {
    currentUITheme,
    themeFromBackend,
    setPreviewTheme,
    saveTheme,
    logo,
    logoType,
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
