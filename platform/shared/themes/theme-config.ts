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
] as const;

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = "cosmic-night";
