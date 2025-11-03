"use client";

import type { OrganizationCustomFont, OrganizationTheme } from "@shared";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { fontFamilyMap, getThemeById } from "@/config/themes";
import { useOrganizationAppearance } from "@/lib/organization.query";

export function OrganizationThemeProvider({
  children,
  previewTheme,
  previewFont,
}: {
  children: React.ReactNode;
  previewTheme?: OrganizationTheme;
  previewFont?: OrganizationCustomFont;
}) {
  const { data: appearance } = useOrganizationAppearance();
  const { theme: colorMode } = useTheme(); // light or dark

  useEffect(() => {
    if (!appearance) return;

    const themeId = previewTheme || appearance.theme || "cosmic-night";
    const fontFamily = previewFont || appearance.customFont || "lato";
    const theme = getThemeById(themeId);

    if (!theme) return;

    // Get the appropriate color set based on current mode
    const colors =
      colorMode === "dark" ? theme.colors.dark : theme.colors.light;

    // Apply theme colors as CSS variables with !important to override hardcoded values
    const root = document.documentElement;
    root.style.setProperty("--primary", colors.primary, "important");
    root.style.setProperty("--secondary", colors.secondary, "important");

    if (colors.sidebar) {
      root.style.setProperty("--sidebar", colors.sidebar, "important");
    }
    if (colors.sidebarAccent) {
      root.style.setProperty(
        "--sidebar-accent",
        colors.sidebarAccent,
        "important",
      );
    }
    if (colors.accent) {
      root.style.setProperty("--accent", colors.accent, "important");
    }

    const fontValue = fontFamilyMap[fontFamily] || fontFamilyMap.lato;
    root.style.setProperty("--font-sans", fontValue);
  }, [appearance, colorMode, previewTheme, previewFont]);

  return <>{children}</>;
}
