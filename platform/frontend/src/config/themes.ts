/**
 * Theme configuration for white-labeling
 * Theme colors are defined in app/themes.css as CSS classes
 * This file re-exports theme metadata from shared utilities
 * All themes from https://github.com/jnsahaj/tweakcn
 * Single source of truth: shared/themes/tweakcn-themes.json
 */

import type { OrganizationCustomFont, OrganizationTheme } from "@shared";
import {
  DEFAULT_THEME_ID,
  getThemeById as getThemeByIdShared,
  getThemeCategories as getThemeCategoriesShared,
  getThemeMetadata,
  getThemesByCategory as getThemesByCategoryShared,
  type ThemeMetadata as ThemeMetadataShared,
} from "@shared";

// Re-export ThemeMetadata for local use
export type ThemeMetadata = ThemeMetadataShared;

/**
 * Get all theme metadata
 * Note: Default theme gets " (Default)" appended to its name
 */
export const themes: ThemeMetadata[] = getThemeMetadata().map((theme) => ({
  ...theme,
  name: theme.id === DEFAULT_THEME_ID ? `${theme.name} (Default)` : theme.name,
}));

/**
 * Get theme by ID
 */
export function getThemeById(id: OrganizationTheme): ThemeMetadata | undefined {
  const theme = getThemeByIdShared(id);
  if (!theme) return undefined;

  return {
    ...theme,
    name:
      theme.id === DEFAULT_THEME_ID ? `${theme.name} (Default)` : theme.name,
  };
}

/**
 * Get themes by category
 */
export function getThemesByCategory(
  category: ThemeMetadata["category"],
): ThemeMetadata[] {
  return getThemesByCategoryShared(category).map((theme) => ({
    ...theme,
    name:
      theme.id === DEFAULT_THEME_ID ? `${theme.name} (Default)` : theme.name,
  }));
}

/**
 * Get all theme categories
 */
export function getThemeCategories(): ReturnType<
  typeof getThemeCategoriesShared
> {
  return getThemeCategoriesShared();
}

export const fontFamilyMap: Record<OrganizationCustomFont, string> = {
  lato: "var(--font-lato), Lato, system-ui, sans-serif",
  inter: "var(--font-inter), Inter, system-ui, sans-serif",
  "open-sans": "var(--font-open-sans), Open Sans, system-ui, sans-serif",
  roboto: "var(--font-roboto), Roboto, system-ui, sans-serif",
  "source-sans-pro":
    "var(--font-source-sans), Source Sans Pro, system-ui, sans-serif",
  "jetbrains-mono": "var(--font-jetbrains-mono), JetBrains Mono, monospace",
};

/**
 * Available font options
 */
export const fonts: Array<{ id: OrganizationCustomFont; name: string }> = [
  { id: "lato", name: "Lato (Default)" },
  { id: "inter", name: "Inter" },
  { id: "open-sans", name: "Open Sans" },
  { id: "roboto", name: "Roboto" },
  { id: "source-sans-pro", name: "Source Sans Pro" },
  { id: "jetbrains-mono", name: "JetBrains Mono" },
];

/**
 * Get font by ID
 */
export function getFontById(id: OrganizationCustomFont) {
  return fonts.find((font) => font.id === id);
}
