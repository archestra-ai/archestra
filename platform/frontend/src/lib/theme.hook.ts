import {
  DEFAULT_THEME_ID,
  type OrganizationCustomFont,
  type OrganizationTheme,
} from "@shared";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fontFamilyMap } from "@/config/themes";
import { usePublicAppearance } from "./appearance.query";
import { useOrganization, useUpdateOrganization } from "./organization.query";

const THEME_STORAGE_KEY = "archestra-theme";
const FONT_STORAGE_KEY = "archestra-font";
const DEFAULT_THEME: OrganizationTheme = DEFAULT_THEME_ID as OrganizationTheme;
const DEFAULT_FONT: OrganizationCustomFont = "lato";

export function useOrgTheme() {
  const pathname = usePathname();

  // Check if we're on an auth page (login, signup, etc.)
  const isAuthPage = pathname?.startsWith("/auth/");

  // Use public appearance endpoint for auth pages (unauthenticated)
  const { data: publicAppearance, isLoading: isLoadingPublicAppearance } =
    usePublicAppearance(isAuthPage);

  // Use authenticated organization endpoint for non-auth pages
  const { data: organizationData, isLoading: isLoadingOrganization } =
    useOrganization(!isAuthPage);

  // Determine loading state based on which endpoint we're using
  const isLoadingAppearance = isAuthPage
    ? isLoadingPublicAppearance
    : isLoadingOrganization;

  // Use data from the appropriate source
  const data = isAuthPage ? publicAppearance : organizationData;
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

  const applyThemeOnBackend = useCallback(
    (themeId: OrganizationTheme) => {
      updateThemeMutation.mutate({
        theme: themeId,
      });
    },
    [updateThemeMutation],
  );

  const applyFontOnBackend = useCallback(
    (fontId: OrganizationCustomFont) => {
      updateThemeMutation.mutate({
        customFont: fontId,
      });
    },
    [updateThemeMutation],
  );

  const saveTheme = useCallback(
    (themeId: OrganizationTheme) => {
      setCurrentUITheme(themeId);
      applyThemeOnBackend(themeId);
      applyThemeInLocalStorage(themeId);
    },
    [applyThemeOnBackend],
  );

  const saveFont = useCallback(
    (fontId: OrganizationCustomFont) => {
      setCurrentUIFont(fontId);
      applyFontOnBackend(fontId);
      applyFontInLocalStorage(fontId);
    },
    [applyFontOnBackend],
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

  // For auth pages, return limited data (read-only appearance, no update functions)
  if (isAuthPage) {
    return {
      currentUITheme: currentUITheme || DEFAULT_THEME,
      currentUIFont: currentUIFont || DEFAULT_FONT,
      themeFromBackend,
      fontFromBackend,
      setPreviewTheme: undefined,
      setPreviewFont: undefined,
      saveTheme: undefined,
      saveFont: undefined,
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
    saveTheme,
    saveFont,
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
