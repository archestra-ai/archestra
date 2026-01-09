import {
  DEFAULT_THEME_ID,
  type OrganizationCustomFont,
  type OrganizationTheme,
} from "@shared";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fontFamilyMap } from "@/config/themes";
import { usePublicAppearance } from "./appearance.query";
import { useUpdateOrganization } from "./organization.query";

const THEME_STORAGE_KEY = "archestra-theme";
const FONT_STORAGE_KEY = "archestra-font";
const DEFAULT_THEME: OrganizationTheme = DEFAULT_THEME_ID as OrganizationTheme;
const DEFAULT_FONT: OrganizationCustomFont = "lato";

export function useOrgTheme() {
  const pathname = usePathname();

  // Check if we're on an auth page (login, signup, etc.)
  const isAuthPage = pathname?.startsWith("/auth/");

  // Always use public appearance endpoint - it returns the same data for all pages
  // and works without authentication
  const { data: appearance, isLoading: isLoadingAppearance } =
    usePublicAppearance();

  const {
    theme: themeFromBackend,
    customFont: fontFromBackend,
    logo,
  } = appearance ?? {};

  const updateThemeMutation = useUpdateOrganization(
    "Appearance settings updated",
    "Failed to update appearance settings",
  );

  const themeFromLocalStorage =
    typeof window !== "undefined"
      ? (localStorage.getItem(THEME_STORAGE_KEY) as OrganizationTheme | null)
      : null;

  const fontFromLocalStorage =
    typeof window !== "undefined"
      ? (localStorage.getItem(
          FONT_STORAGE_KEY,
        ) as OrganizationCustomFont | null)
      : null;

  const [currentUITheme, setCurrentUITheme] = useState<OrganizationTheme>(
    themeFromBackend || themeFromLocalStorage || DEFAULT_THEME,
  );

  const [currentUIFont, setCurrentUIFont] = useState<OrganizationCustomFont>(
    fontFromBackend || fontFromLocalStorage || DEFAULT_FONT,
  );

  const saveAppearance = useCallback(
    (themeId: OrganizationTheme, fontId: OrganizationCustomFont) => {
      setCurrentUITheme(themeId);
      setCurrentUIFont(fontId);
      updateThemeMutation.mutate({
        theme: themeId,
        customFont: fontId,
      });
      applyThemeInLocalStorage(themeId);
      applyFontInLocalStorage(fontId);
    },
    [updateThemeMutation],
  );

  // whenever currentUITheme changes, apply the theme on the UI
  useEffect(() => {
    applyThemeOnUI(currentUITheme);
  }, [currentUITheme]);

  // whenever currentUIFont changes, apply the font on the UI
  useEffect(() => {
    applyFontOnUI(currentUIFont);
  }, [currentUIFont]);

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

  // whenever fontFromBackend is loaded and is different from fontFromLocalStorage, update local storage and UI
  // Only sync after actual data loads (not during placeholder loading) to prevent flicker
  useEffect(() => {
    if (
      !isLoadingAppearance &&
      fontFromBackend &&
      fontFromBackend !== fontFromLocalStorage
    ) {
      applyFontInLocalStorage(fontFromBackend);
      setCurrentUIFont(fontFromBackend);
    }
  }, [fontFromBackend, fontFromLocalStorage, isLoadingAppearance]);

  // For auth pages, return limited data (read-only appearance, no update functions)
  if (isAuthPage) {
    return {
      currentUITheme: currentUITheme || DEFAULT_THEME,
      currentUIFont: currentUIFont || DEFAULT_FONT,
      themeFromBackend,
      fontFromBackend,
      setPreviewTheme: undefined,
      setPreviewFont: undefined,
      saveAppearance: undefined,
      logo,
      DEFAULT_THEME,
      DEFAULT_FONT,
      isLoadingAppearance,
      applyThemeOnUI,
      applyFontOnUI,
    };
  }

  return {
    currentUITheme: currentUITheme || DEFAULT_THEME,
    currentUIFont: currentUIFont || DEFAULT_FONT,
    themeFromBackend,
    fontFromBackend,
    setPreviewTheme: setCurrentUITheme,
    setPreviewFont: setCurrentUIFont,
    saveAppearance,
    logo,
    DEFAULT_THEME,
    DEFAULT_FONT,
    isLoadingAppearance,
    applyThemeOnUI,
    applyFontOnUI,
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

const applyFontOnUI = (fontId: OrganizationCustomFont) => {
  // Apply to body because Next.js font variables are defined on body via classes
  const body = document.body;
  const fontFamily = fontFamilyMap[fontId];
  if (fontFamily) {
    body.style.setProperty("--font-sans", fontFamily);
  }
};

const applyThemeInLocalStorage = (themeId: OrganizationTheme) => {
  localStorage.setItem(THEME_STORAGE_KEY, themeId);
};

const applyFontInLocalStorage = (fontId: OrganizationCustomFont) => {
  localStorage.setItem(FONT_STORAGE_KEY, fontId);
};
