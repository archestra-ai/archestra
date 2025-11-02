"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { getThemeById } from "@/config/themes";
import { useOrganizationAppearance } from "@/lib/organization.query";

export function OrganizationThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: appearance } = useOrganizationAppearance();
  const { theme: colorMode } = useTheme(); // light or dark

  useEffect(() => {
    if (!appearance) return;

    const themeId = appearance.theme || "cosmic-night";
    const fontFamily = appearance.customFont || "lato";
    const theme = getThemeById(themeId);

    if (!theme) return;

    // Get the appropriate color set based on current mode
    const colors =
      colorMode === "dark" ? theme.colors.dark : theme.colors.light;

    // Apply theme colors as CSS variables
    const root = document.documentElement;
    root.style.setProperty("--primary", colors.primary);
    root.style.setProperty("--secondary", colors.secondary);

    if (colors.sidebar) {
      root.style.setProperty("--sidebar-background", colors.sidebar);
    }
    if (colors.sidebarAccent) {
      root.style.setProperty("--sidebar-accent", colors.sidebarAccent);
    }
    if (colors.accent) {
      root.style.setProperty("--accent", colors.accent);
    }

    // Apply font family
    const fontFamilyMap: Record<string, string> = {
      lato: '"Lato", system-ui, sans-serif',
      inter: '"Inter", system-ui, sans-serif',
      "open-sans": '"Open Sans", system-ui, sans-serif',
      roboto: '"Roboto", system-ui, sans-serif',
      "source-sans-pro": '"Source Sans Pro", system-ui, sans-serif',
    };

    const fontValue =
      fontFamilyMap[fontFamily] || fontFamilyMap.lato;
    root.style.setProperty("--font-sans", fontValue);
  }, [appearance, colorMode]);

  return <>{children}</>;
}
