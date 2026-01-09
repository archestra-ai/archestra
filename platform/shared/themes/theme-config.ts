/**
 * Theme configuration - defines which themes from tweakcn registry we support
 * and their categorization for the UI
 */

export type ThemeCategory = "minimal" | "vibrant" | "dark" | "nature" | "tech";

export interface ThemeConfig {
  id: string;
  category: ThemeCategory;
  // Whether this is the default theme
  isDefault?: boolean;
}

/**
 * Supported themes from the tweakcn registry
 * This is the single source of truth for which themes are available
 */
export const SUPPORTED_THEMES = [
  // Minimal & Clean
  { id: "modern-minimal", category: "minimal" },
  { id: "graphite", category: "minimal" },
  { id: "clean-slate", category: "minimal" },
  { id: "mono", category: "minimal" },
  { id: "elegant-luxury", category: "minimal" },
  { id: "claymorphism", category: "minimal" },

  // Vibrant & Colorful
  { id: "t3-chat", category: "vibrant" },
  { id: "twitter", category: "vibrant" },
  { id: "bubblegum", category: "vibrant" },
  { id: "tangerine", category: "vibrant" },
  { id: "quantum-rose", category: "vibrant" },
  { id: "candyland", category: "vibrant" },
  { id: "pastel-dreams", category: "vibrant" },
  { id: "retro-arcade", category: "vibrant" },
  { id: "caffeine", category: "vibrant" },
  { id: "amber-minimal", category: "vibrant" },

  // Dark & Atmospheric
  { id: "cosmic-night", category: "dark" },
  { id: "doom-64", category: "dark" },
  { id: "catppuccin", category: "dark" },
  { id: "perpetuity", category: "dark" },
  { id: "midnight-bloom", category: "dark" },
  { id: "starry-night", category: "dark" },
  { id: "cyberpunk", category: "dark" },

  // Nature & Earthy
  { id: "mocha-mousse", category: "nature" },
  { id: "kodama-grove", category: "nature" },
  { id: "nature", category: "nature" },
  { id: "ocean-breeze", category: "nature" },
  { id: "sunset-horizon", category: "nature" },
  { id: "solar-dusk", category: "nature" },

  // Tech & Bold
  { id: "bold-tech", category: "tech" },
  { id: "neo-brutalism", category: "tech" },
  { id: "supabase", category: "tech" },
  { id: "vercel", category: "tech" },
  { id: "claude", category: "tech" },
  { id: "northern-lights", category: "tech" },
  { id: "vintage-paper", category: "tech" },
  { id: "boxy-minimalistic", category: "minimal" },
] as const;

export const THEME_IDS = SUPPORTED_THEMES.map((t) => t.id) as unknown as [
  (typeof SUPPORTED_THEMES)[number]["id"],
  ...Array<(typeof SUPPORTED_THEMES)[number]["id"]>,
];

/**
 * Category labels for display
 */
export const THEME_CATEGORY_LABELS: Record<ThemeCategory, string> = {
  minimal: "Minimal & Clean",
  vibrant: "Vibrant & Colorful",
  dark: "Dark & Atmospheric",
  nature: "Nature & Earthy",
  tech: "Tech & Bold",
};

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = "cosmic-night";
