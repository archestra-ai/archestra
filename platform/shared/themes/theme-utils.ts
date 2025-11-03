/**
 * Theme utilities - processes tweakcn-themes.json to extract theme data
 */

import themeRegistry from "./tweakcn-themes.json";
import {
	DEFAULT_THEME_ID,
	SUPPORTED_THEMES,
	THEME_CATEGORY_LABELS,
	THEME_IDS,
	type ThemeCategory,
} from "./theme-config";

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
		return {
			id: config.id,
			name: item?.title || config.id,
			category: config.category,
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
export function getThemesByCategory(
	category: ThemeCategory,
): ThemeMetadata[] {
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
