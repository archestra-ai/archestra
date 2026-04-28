/**
 * Theme utilities - processes tweakcn-themes.json to extract theme data
 */

import {
  DARK_ONLY_THEMES,
  DEFAULT_THEME_ID,
  LIGHT_ONLY_THEMES,
  SUPPORTED_THEMES,
} from "./theme-config";
import themeRegistry from "./tweakcn-themes.json";

// Re-export for convenience
export { DARK_ONLY_THEMES, DEFAULT_THEME_ID, LIGHT_ONLY_THEMES };

// Extract theme ID type from the const tuple
export type ThemeId = (typeof SUPPORTED_THEMES)[number];

export interface ThemeItem {
  name: ThemeId;
  title: string;
  description: string;
  cssVars: {
    theme: Record<string, string>;
    light: Record<string, string>;
    dark: Record<string, string>;
  };
}

export interface ThemeMetadata {
  id: ThemeId;
  name: string;
  /** Set when the theme only works in one mode */
  mode?: "light-only" | "dark-only";
}

/**
 * Get all supported theme items from the registry
 */
export function getSupportedThemeItems(): ThemeItem[] {
  const supportedIds = new Set(SUPPORTED_THEMES);

  return (themeRegistry.items as ThemeItem[]).filter((item) =>
    supportedIds.has(item.name),
  );
}

/**
 * Get theme metadata for frontend use
 */
export function getThemeMetadata(): ThemeMetadata[] {
  const themeItems = getSupportedThemeItems();
  const itemsByName = new Map(themeItems.map((item) => [item.name, item]));

  return SUPPORTED_THEMES.map((id) => {
    const item = itemsByName.get(id);
    const requiredMode = getThemeRequiredMode(id);
    const mode =
      requiredMode === "light"
        ? ("light-only" as const)
        : requiredMode === "dark"
          ? ("dark-only" as const)
          : undefined;

    return {
      id,
      name: item?.title || id,
      ...(mode !== undefined && { mode }),
    };
  });
}

/**
 * Returns the mode that a theme requires, or null if it supports both.
 */
export function getThemeRequiredMode(id: ThemeId): "light" | "dark" | null {
  if ((LIGHT_ONLY_THEMES as readonly string[]).includes(id)) return "light";
  if ((DARK_ONLY_THEMES as readonly string[]).includes(id)) return "dark";
  return null;
}

/**
 * Get theme metadata by ID
 */
export function getThemeById(id: ThemeId): ThemeMetadata | undefined {
  return getThemeMetadata().find((theme) => theme.id === id);
}

/**
 * Get theme item data from registry (includes CSS vars)
 */
export function getThemeItemById(id: string): ThemeItem | undefined {
  return getSupportedThemeItems().find((item) => item.name === id);
}
