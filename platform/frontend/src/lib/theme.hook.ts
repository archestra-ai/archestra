import {
  DEFAULT_THEME_ID,
  type OrganizationCustomFont,
  type OrganizationTheme,
} from "@shared";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fontFamilyMap } from "@/config/themes";
import { useOrganization, useUpdateOrganization } from "./organization.query";

const THEME_STORAGE_KEY = "archestra-theme";
const FONT_STORAGE_KEY = "archestra-font";
const DEFAULT_THEME: OrganizationTheme = DEFAULT_THEME_ID as OrganizationTheme;
const DEFAULT_FONT: OrganizationCustomFont = "lato";

export function useOrgTheme() {
  const pathname = usePathname();

  // Don't load org theme on auth pages to avoid 401 errors during 2FA flow
  const isAuthPage = pathname?.startsWith("/auth/");

  const { data, isLoading: isLoadingAppearance } = useOrganization(!isAuthPage);
  const {
    theme: themeFromBackend,
    customFont: fontFromBackend,
    logo,
  } = data ?? {};
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
    themeFromLocalStorage || themeFromBackend || DEFAULT_THEME,
  );

  const [currentUIFont, setCurrentUIFont] = useState<OrganizationCustomFont>(
    fontFromLocalStorage || fontFromBackend || DEFAULT_FONT,
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

  // whenever themeFromBackend is loaded and is different from themeFromLocalStorage, update local storage
  useEffect(() => {
    if (themeFromBackend && themeFromBackend !== themeFromLocalStorage) {
      applyThemeInLocalStorage(themeFromBackend);
    }
  }, [themeFromBackend, themeFromLocalStorage]);

  // whenever fontFromBackend is loaded and is different from fontFromLocalStorage, update local storage
  useEffect(() => {
    if (fontFromBackend && fontFromBackend !== fontFromLocalStorage) {
      applyFontInLocalStorage(fontFromBackend);
    }
  }, [fontFromBackend, fontFromLocalStorage]);

  // Don't load org theme on auth pages to avoid 401 errors during 2FA flow
  if (isAuthPage) {
    return null;
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
  const root = document.documentElement;
  const fontFamily = fontFamilyMap[fontId];
  if (fontFamily) {
    root.style.setProperty("--font-sans", fontFamily);
  }
};

const applyThemeInLocalStorage = (themeId: OrganizationTheme) => {
  localStorage.setItem(THEME_STORAGE_KEY, themeId);
};

const applyFontInLocalStorage = (fontId: OrganizationCustomFont) => {
  localStorage.setItem(FONT_STORAGE_KEY, fontId);
};
