/**
 * Theme configuration for white-labeling
 * Theme colors are defined in app/themes.css as CSS classes
 * This file re-exports theme metadata from shared utilities
 * All themes from https://github.com/jnsahaj/tweakcn
 * Single source of truth: shared/themes/tweakcn-themes.json
 */

import type { OrganizationTheme } from "@shared";
import {
  DEFAULT_THEME_ID,
  getThemeById as getThemeByIdShared,
  getThemeMetadata,
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
