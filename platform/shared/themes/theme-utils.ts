/**
 * Theme utilities - processes tweakcn-themes.json to extract theme data
 */

import {
  DEFAULT_THEME_ID,
  SUPPORTED_THEMES,
  THEME_CATEGORY_LABELS,
  type THEME_IDS,
  type ThemeCategory,
} from "./theme-config";
import themeRegistry from "./tweakcn-themes.json";

// Re-export for convenience
export { DEFAULT_THEME_ID };

// Extract theme ID type from the const tuple
export type ThemeId = (typeof THEME_IDS)[number];

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
  category: ThemeCategory;
  fontFamily: string;
  fontDisplayName: string;
}

/**
 * Extract display name from a CSS font-family value
 * e.g., "Inter, sans-serif" -> "Inter"
 * e.g., "ui-sans-serif, system-ui..." -> "System"
 */
export function extractFontDisplayName(fontFamily: string): string {
  // Handle system font stack
  if (fontFamily.startsWith("ui-sans-serif") || fontFamily.startsWith("ui-")) {
    return "System";
  }

  // Extract the first font name (before the comma)
  const firstFont = fontFamily.split(",")[0].trim();

  // Remove quotes if present
  return firstFont.replace(/["']/g, "");
}

/**
 * Get all supported theme items from the registry
 */
export function getSupportedThemeItems(): ThemeItem[] {
  const supportedIds = new Set(SUPPORTED_THEMES.map((t) => t.id));

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

  return SUPPORTED_THEMES.map((config) => {
    const item = itemsByName.get(config.id);
    // Extract font-sans from light mode vars (fallback to theme vars, then default)
    const fontFamily =
      item?.cssVars.light?.["font-sans"] ||
      item?.cssVars.theme?.["font-sans"] ||
      "Inter, sans-serif";
    return {
      id: config.id,
      name: item?.title || config.id,
      category: config.category,
      fontFamily,
      fontDisplayName: extractFontDisplayName(fontFamily),
    };
  }).filter((theme): theme is ThemeMetadata => theme !== null);
}

/**
 * Get theme metadata by ID
 */
export function getThemeById(id: ThemeId): ThemeMetadata | undefined {
  return getThemeMetadata().find((theme) => theme.id === id);
}

/**
 * Get themes by category
 */
export function getThemesByCategory(category: ThemeCategory): ThemeMetadata[] {
  return getThemeMetadata().filter((theme) => theme.category === category);
}

/**
 * Get all theme categories with labels
 */
export function getThemeCategories(): Array<{
  id: ThemeCategory;
  label: string;
}> {
  return Object.entries(THEME_CATEGORY_LABELS).map(([id, label]) => ({
    id: id as ThemeCategory,
    label,
  }));
}

/**
 * Get theme item data from registry (includes CSS vars)
 */
export function getThemeItemById(id: string): ThemeItem | undefined {
  return getSupportedThemeItems().find((item) => item.name === id);
}
