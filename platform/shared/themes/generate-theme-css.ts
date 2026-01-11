/**
 * biome-ignore-all lint/suspicious/noConsole: this is a script
 *
 * Script to generate CSS from tweakcn-themes.json
 * This ensures the JSON file is the single source of truth for theme definitions
 *
 * Usage: pnpm codegen:theme-css
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Import theme configuration
import {
  DARK_ONLY_THEMES,
  LIGHT_ONLY_THEMES,
  SUPPORTED_THEMES,
} from "./theme-config";
import type { ThemeId } from "./theme-utils";
import themeRegistry from "./tweakcn-themes.json";

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

// Variables to include from themes (in addition to oklch colors)
const INCLUDED_VARS = [
  // Border radius
  "radius",
  // Fonts
  "font-sans",
  "font-mono",
  "font-serif",
  // Spacing
  "spacing",
  // Letter spacing / tracking
  "letter-spacing",
  "tracking-tighter",
  "tracking-tight",
  "tracking-normal",
  "tracking-wide",
  "tracking-wider",
  "tracking-widest",
  // Shadows
  "shadow-2xs",
  "shadow-xs",
  "shadow-sm",
  "shadow",
  "shadow-md",
  "shadow-lg",
  "shadow-xl",
  "shadow-2xl",
];

/**
 * Generate CSS variables for a theme
 * Includes OKLCH color values, fonts, spacing, tracking, radius, and shadows
 */
function generateCSSVars(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => {
      // Keep variables with oklch values (colors)
      if (value.includes("oklch")) {
        return `  --${key}: ${value};`;
      }
      // Keep other included variables
      if (INCLUDED_VARS.includes(key)) {
        return `  --${key}: ${value};`;
      }
      // ignore everything else
      return undefined;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Generate CSS class for a theme
 * Uses html.theme-* selector for higher specificity to override :root defaults
 */
function generateThemeCSS(theme: ThemeItem): string {
  const className = `theme-${theme.name}`;
  const isLightOnly = (LIGHT_ONLY_THEMES as readonly string[]).includes(
    theme.name,
  );
  const isDarkOnly = (DARK_ONLY_THEMES as readonly string[]).includes(
    theme.name,
  );

  // Generate light mode CSS - use html.class for higher specificity than :root
  const lightCSS = `html.${className} {\n${generateCSSVars(theme.cssVars.light)}\n}`;

  // Generate dark mode CSS
  const darkCSS = `html.dark.${className} {\n${generateCSSVars(theme.cssVars.dark)}\n}`;

  // Dark-only themes: only output dark mode CSS
  if (isDarkOnly) {
    return `/* ${theme.title} (dark only) */\n${darkCSS}`;
  }

  // Light-only themes: only output light mode CSS
  if (isLightOnly) {
    return `/* ${theme.title} (light only) */\n${lightCSS}`;
  }

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
  const supportedThemeIds = new Set(SUPPORTED_THEMES);
  const supportedThemes = (themeRegistry.items as ThemeItem[]).filter((item) =>
    supportedThemeIds.has(item.name as ThemeId),
  );

  // Sort themes by the order in SUPPORTED_THEMES for consistency
  const themeOrder = new Map(SUPPORTED_THEMES.map((id, index) => [id, index]));
  supportedThemes.sort(
    (a, b) =>
      (themeOrder.get(a.name as ThemeId) ?? 999) -
      (themeOrder.get(b.name as ThemeId) ?? 999),
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
  console.log(`📊 Generated ${SUPPORTED_THEMES.length} themes`);
}

main();
