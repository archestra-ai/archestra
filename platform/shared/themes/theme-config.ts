/**
 * Theme configuration - defines which themes from tweakcn registry we support
 */

/**
 * Supported themes from the tweakcn registry
 * This is the single source of truth for which themes are available
 */
export const SUPPORTED_THEMES = [
  "modern-minimal",
  "clean-slate",
  "mono",
  "twitter",
  "tangerine",
  "bubblegum",
  "caffeine",
  "amber-minimal",
  "cosmic-night",
  "doom-64",
  "mocha-mousse",
  "nature",
  "sunset-horizon",
  "neo-brutalism",
  "vercel",
  "claude",
  "vintage-paper",
  "boxy-minimalistic",
  "catppuccin",
  "solarized-dark",
  "gruvbox-dark",
  "dracula-dark",
  "monokai-dark",
  "moonlight-dark",
] as const;

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = "cosmic-night";

/**
 * Themes that only support light mode (no dark variant)
 */
export const LIGHT_ONLY_THEMES = [
  "bubblegum",
] as const satisfies readonly (typeof SUPPORTED_THEMES)[number][];

/**
 * Themes that only support dark mode (no light variant)
 */
export const DARK_ONLY_THEMES = [
  "solarized-dark",
  "gruvbox-dark",
  "dracula-dark",
  "monokai-dark",
  "moonlight-dark",
] as const satisfies readonly (typeof SUPPORTED_THEMES)[number][];
