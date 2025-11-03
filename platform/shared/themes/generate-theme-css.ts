/**
 * Script to generate CSS from tweakcn-themes.json
 * This ensures the JSON file is the single source of truth for theme definitions
 *
 * Usage: pnpm codegen:theme-css
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Import theme configuration
import { THEME_IDS } from "./theme-config";
import themeRegistry from "./tweakcn-themes.json";
import { ThemeId } from "./theme-utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ThemeItem {
	name: string;
	title: string;
	description: string;
	cssVars: {
		theme: Record<string, string>;
		light: Record<string, string>;
		dark: Record<string, string>;
	};
}

/**
 * Generate CSS variables for a theme
 * Only OKLCH color values are active - all other variables are commented out
 */
function generateCSSVars(vars: Record<string, string>): string {
	return Object.entries(vars)
		.map(([key, value]) => {
			// Only keep variables with oklch values (colors)
			if (value.includes("oklch")) {
				return `  --${key}: ${value};`;
			}
			// ignore everything else (fonts, radius, shadows, etc.)
			return undefined;
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Generate CSS class for a theme
 */
function generateThemeCSS(theme: ThemeItem): string {
	const className = `theme-${theme.name}`;

	// Generate light mode CSS
	const lightCSS = `.${className} {\n${generateCSSVars(theme.cssVars.light)}\n}`;

	// Generate dark mode CSS
	const darkCSS = `.dark.${className} {\n${generateCSSVars(theme.cssVars.dark)}\n}`;

	return `/* ${theme.title} */\n${lightCSS}\n\n${darkCSS}`;
}

/**
 * Generate complete CSS file
 */
function generateThemesCSS(): string {
	const header = `/**
 * Theme definitions for Archestra platform
 * All themes from https://github.com/jnsahaj/tweakcn
 * Each theme is a class that can be applied to the root element
 * Themes respond to .dark class for dark mode
 *
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * Generated from shared/themes/tweakcn-themes.json
 * Run: pnpm codegen:theme-css
 */\n`;

	// Filter to only supported themes
	const supportedThemeIds = new Set(THEME_IDS);
	const supportedThemes = (themeRegistry.items as ThemeItem[]).filter(
		(item) => supportedThemeIds.has(item.name as ThemeId),
	);

	// Sort themes by the order in THEME_IDS for consistency
	const themeOrder = new Map(THEME_IDS.map((id, index) => [id, index]));
	supportedThemes.sort(
		(a, b) => (themeOrder.get(a.name as ThemeId) ?? 999) - (themeOrder.get(b.name as ThemeId) ?? 999),
	);

	// Generate CSS for each theme
	const themesCSS = supportedThemes.map(generateThemeCSS).join("\n\n");

	return `${header}\n${themesCSS}\n`;
}

/**
 * Main function
 */
function main() {
	const outputPath = path.join(
		__dirname,
		"..",
		"..",
		"frontend",
		"src",
		"app",
		"themes.css",
	);

	const css = generateThemesCSS();
	fs.writeFileSync(outputPath, css, "utf-8");

	console.log(`✅ Generated ${outputPath}`);
	console.log(`📊 Generated ${THEME_IDS.length} themes`);
}

main();
