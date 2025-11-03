/**
 * Theme configuration for white-labeling
 * Each theme defines color values that will be applied as CSS custom properties
 */

import type { OrganizationCustomFont, OrganizationTheme } from "@shared";

interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  sidebar: string;
  sidebarAccent: string;
}

export interface Theme {
  id: OrganizationTheme;
  name: string;
  category: "single-color" | "vision-assistive" | "fun-and-new";
  colors: {
    light: ThemeColors;
    dark: ThemeColors;
  };
}

export const themes: Theme[] = [
  // Single Color Themes
  {
    id: "cosmic-night",
    name: "Cosmic Night (Default)",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.4341 0.0392 41.9938)",
        secondary: "oklch(0.9200 0.0651 74.3695)",
        accent: "oklch(0.5200 0.0651 74.3695)",
        sidebar: "oklch(0.9800 0.0051 74.3695)",
        sidebarAccent: "oklch(0.9200 0.0651 74.3695)",
      },
      dark: {
        primary: "oklch(0.9247 0.0524 66.1732)",
        secondary: "oklch(0.2628 0.0196 285.8852)",
        accent: "oklch(0.7247 0.0824 66.1732)",
        sidebar: "oklch(0.2103 0.0059 285.8852)",
        sidebarAccent: "oklch(0.4882 0.2172 264.3763)",
      },
    },
  },
  {
    id: "aubergine",
    name: "Aubergine",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.45 0.15 330)",
        secondary: "oklch(0.92 0.02 330)",
        accent: "oklch(0.55 0.18 330)",
        sidebar: "oklch(0.98 0.01 330)",
        sidebarAccent: "oklch(0.92 0.02 330)",
      },
      dark: {
        primary: "oklch(0.75 0.15 330)",
        secondary: "oklch(0.25 0.05 330)",
        accent: "oklch(0.65 0.20 330)",
        sidebar: "oklch(0.20 0.08 330)",
        sidebarAccent: "oklch(0.55 0.18 330)",
      },
    },
  },
  {
    id: "clementine",
    name: "Clementine",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.60 0.20 45)",
        secondary: "oklch(0.95 0.05 45)",
        accent: "oklch(0.70 0.25 45)",
        sidebar: "oklch(0.98 0.02 45)",
        sidebarAccent: "oklch(0.95 0.05 45)",
      },
      dark: {
        primary: "oklch(0.80 0.18 45)",
        secondary: "oklch(0.25 0.05 45)",
        accent: "oklch(0.70 0.22 45)",
        sidebar: "oklch(0.20 0.08 45)",
        sidebarAccent: "oklch(0.65 0.20 45)",
      },
    },
  },
  {
    id: "banana",
    name: "Banana",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.75 0.15 95)",
        secondary: "oklch(0.95 0.08 95)",
        accent: "oklch(0.65 0.18 95)",
        sidebar: "oklch(0.98 0.04 95)",
        sidebarAccent: "oklch(0.95 0.08 95)",
      },
      dark: {
        primary: "oklch(0.85 0.15 95)",
        secondary: "oklch(0.30 0.05 95)",
        accent: "oklch(0.75 0.20 95)",
        sidebar: "oklch(0.25 0.08 95)",
        sidebarAccent: "oklch(0.70 0.18 95)",
      },
    },
  },
  {
    id: "jade",
    name: "Jade",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.55 0.15 160)",
        secondary: "oklch(0.92 0.05 160)",
        accent: "oklch(0.65 0.18 160)",
        sidebar: "oklch(0.98 0.02 160)",
        sidebarAccent: "oklch(0.92 0.05 160)",
      },
      dark: {
        primary: "oklch(0.70 0.15 160)",
        secondary: "oklch(0.25 0.05 160)",
        accent: "oklch(0.60 0.20 160)",
        sidebar: "oklch(0.20 0.08 160)",
        sidebarAccent: "oklch(0.55 0.18 160)",
      },
    },
  },
  {
    id: "lagoon",
    name: "Lagoon",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.50 0.12 230)",
        secondary: "oklch(0.92 0.05 230)",
        accent: "oklch(0.60 0.15 230)",
        sidebar: "oklch(0.98 0.02 230)",
        sidebarAccent: "oklch(0.92 0.05 230)",
      },
      dark: {
        primary: "oklch(0.70 0.12 230)",
        secondary: "oklch(0.25 0.05 230)",
        accent: "oklch(0.60 0.18 230)",
        sidebar: "oklch(0.20 0.08 230)",
        sidebarAccent: "oklch(0.55 0.15 230)",
      },
    },
  },
  {
    id: "barbra",
    name: "Barbra",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.60 0.20 350)",
        secondary: "oklch(0.95 0.05 350)",
        accent: "oklch(0.70 0.25 350)",
        sidebar: "oklch(0.98 0.02 350)",
        sidebarAccent: "oklch(0.95 0.05 350)",
      },
      dark: {
        primary: "oklch(0.75 0.18 350)",
        secondary: "oklch(0.25 0.05 350)",
        accent: "oklch(0.65 0.22 350)",
        sidebar: "oklch(0.20 0.08 350)",
        sidebarAccent: "oklch(0.60 0.20 350)",
      },
    },
  },
  {
    id: "gray",
    name: "Gray",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.45 0.00 0)",
        secondary: "oklch(0.92 0.00 0)",
        accent: "oklch(0.55 0.00 0)",
        sidebar: "oklch(0.98 0.00 0)",
        sidebarAccent: "oklch(0.92 0.00 0)",
      },
      dark: {
        primary: "oklch(0.85 0.00 0)",
        secondary: "oklch(0.25 0.00 0)",
        accent: "oklch(0.65 0.00 0)",
        sidebar: "oklch(0.20 0.00 0)",
        sidebarAccent: "oklch(0.50 0.00 0)",
      },
    },
  },
  {
    id: "mood-indigo",
    name: "Mood Indigo",
    category: "single-color",
    colors: {
      light: {
        primary: "oklch(0.40 0.15 265)",
        secondary: "oklch(0.90 0.05 265)",
        accent: "oklch(0.50 0.20 265)",
        sidebar: "oklch(0.96 0.02 265)",
        sidebarAccent: "oklch(0.90 0.05 265)",
      },
      dark: {
        primary: "oklch(0.70 0.15 265)",
        secondary: "oklch(0.20 0.08 265)",
        accent: "oklch(0.60 0.22 265)",
        sidebar: "oklch(0.18 0.10 265)",
        sidebarAccent: "oklch(0.50 0.20 265)",
      },
    },
  },

  // Vision Assistive Themes
  {
    id: "tritanopia",
    name: "Tritanopia",
    category: "vision-assistive",
    colors: {
      light: {
        primary: "oklch(0.45 0.20 25)",
        secondary: "oklch(0.92 0.05 25)",
        accent: "oklch(0.55 0.25 25)",
        sidebar: "oklch(0.98 0.02 25)",
        sidebarAccent: "oklch(0.92 0.05 25)",
      },
      dark: {
        primary: "oklch(0.80 0.20 25)",
        secondary: "oklch(0.25 0.05 25)",
        accent: "oklch(0.70 0.25 25)",
        sidebar: "oklch(0.20 0.08 25)",
        sidebarAccent: "oklch(0.65 0.22 25)",
      },
    },
  },
  {
    id: "protanopia-deuteranopia",
    name: "Protanopia & Deuteranopia",
    category: "vision-assistive",
    colors: {
      light: {
        primary: "oklch(0.50 0.18 210)",
        secondary: "oklch(0.90 0.05 210)",
        accent: "oklch(0.60 0.22 210)",
        sidebar: "oklch(0.96 0.02 210)",
        sidebarAccent: "oklch(0.90 0.05 210)",
      },
      dark: {
        primary: "oklch(0.75 0.18 210)",
        secondary: "oklch(0.25 0.05 210)",
        accent: "oklch(0.65 0.22 210)",
        sidebar: "oklch(0.20 0.08 210)",
        sidebarAccent: "oklch(0.60 0.20 210)",
      },
    },
  },

  // Fun and New Themes
  {
    id: "raspberry-beret",
    name: "Raspberry Beret",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.55 0.22 340)",
        secondary: "oklch(0.95 0.05 340)",
        accent: "oklch(0.65 0.28 340)",
        sidebar: "oklch(0.98 0.02 340)",
        sidebarAccent: "oklch(0.95 0.05 340)",
      },
      dark: {
        primary: "oklch(0.75 0.22 340)",
        secondary: "oklch(0.25 0.05 340)",
        accent: "oklch(0.65 0.28 340)",
        sidebar: "oklch(0.22 0.10 340)",
        sidebarAccent: "oklch(0.60 0.25 340)",
      },
    },
  },
  {
    id: "big-business",
    name: "Big Business",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.35 0.12 250)",
        secondary: "oklch(0.90 0.05 250)",
        accent: "oklch(0.45 0.18 250)",
        sidebar: "oklch(0.96 0.02 250)",
        sidebarAccent: "oklch(0.90 0.05 250)",
      },
      dark: {
        primary: "oklch(0.65 0.12 250)",
        secondary: "oklch(0.22 0.05 250)",
        accent: "oklch(0.55 0.18 250)",
        sidebar: "oklch(0.18 0.08 250)",
        sidebarAccent: "oklch(0.50 0.15 250)",
      },
    },
  },
  {
    id: "pog",
    name: "POG",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.60 0.20 320)",
        secondary: "oklch(0.92 0.08 20)",
        accent: "oklch(0.70 0.15 120)",
        sidebar: "oklch(0.98 0.04 20)",
        sidebarAccent: "oklch(0.92 0.08 20)",
      },
      dark: {
        primary: "oklch(0.75 0.20 320)",
        secondary: "oklch(0.25 0.05 20)",
        accent: "oklch(0.65 0.25 320)",
        sidebar: "oklch(0.20 0.08 320)",
        sidebarAccent: "oklch(0.60 0.22 320)",
      },
    },
  },
  {
    id: "mint-chip",
    name: "Mint Chip",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.65 0.15 170)",
        secondary: "oklch(0.95 0.05 170)",
        accent: "oklch(0.50 0.10 30)",
        sidebar: "oklch(0.98 0.02 170)",
        sidebarAccent: "oklch(0.95 0.05 170)",
      },
      dark: {
        primary: "oklch(0.75 0.15 170)",
        secondary: "oklch(0.25 0.05 170)",
        accent: "oklch(0.65 0.20 170)",
        sidebar: "oklch(0.22 0.08 170)",
        sidebarAccent: "oklch(0.60 0.18 170)",
      },
    },
  },
  {
    id: "pbj",
    name: "PB&J",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.55 0.18 35)",
        secondary: "oklch(0.92 0.08 320)",
        accent: "oklch(0.65 0.12 280)",
        sidebar: "oklch(0.98 0.04 320)",
        sidebarAccent: "oklch(0.92 0.08 320)",
      },
      dark: {
        primary: "oklch(0.70 0.18 35)",
        secondary: "oklch(0.25 0.08 320)",
        accent: "oklch(0.60 0.22 35)",
        sidebar: "oklch(0.22 0.10 35)",
        sidebarAccent: "oklch(0.58 0.20 35)",
      },
    },
  },
  {
    id: "chill-vibes",
    name: "Chill Vibes",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.60 0.12 200)",
        secondary: "oklch(0.92 0.05 200)",
        accent: "oklch(0.70 0.15 200)",
        sidebar: "oklch(0.98 0.02 200)",
        sidebarAccent: "oklch(0.92 0.05 200)",
      },
      dark: {
        primary: "oklch(0.70 0.12 200)",
        secondary: "oklch(0.25 0.05 200)",
        accent: "oklch(0.60 0.18 200)",
        sidebar: "oklch(0.20 0.08 200)",
        sidebarAccent: "oklch(0.55 0.15 200)",
      },
    },
  },
  {
    id: "forest-floor",
    name: "Forest Floor",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.45 0.12 140)",
        secondary: "oklch(0.90 0.05 140)",
        accent: "oklch(0.55 0.18 140)",
        sidebar: "oklch(0.96 0.02 140)",
        sidebarAccent: "oklch(0.90 0.05 140)",
      },
      dark: {
        primary: "oklch(0.65 0.12 140)",
        secondary: "oklch(0.22 0.05 140)",
        accent: "oklch(0.55 0.18 140)",
        sidebar: "oklch(0.18 0.08 140)",
        sidebarAccent: "oklch(0.50 0.15 140)",
      },
    },
  },
  {
    id: "slackr",
    name: "Slackr",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.55 0.18 275)",
        secondary: "oklch(0.92 0.08 60)",
        accent: "oklch(0.65 0.15 320)",
        sidebar: "oklch(0.98 0.04 60)",
        sidebarAccent: "oklch(0.92 0.08 60)",
      },
      dark: {
        primary: "oklch(0.72 0.18 275)",
        secondary: "oklch(0.25 0.08 60)",
        accent: "oklch(0.62 0.22 275)",
        sidebar: "oklch(0.20 0.10 275)",
        sidebarAccent: "oklch(0.58 0.20 275)",
      },
    },
  },
  {
    id: "sea-glass",
    name: "Sea Glass",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.65 0.12 185)",
        secondary: "oklch(0.95 0.05 185)",
        accent: "oklch(0.70 0.10 160)",
        sidebar: "oklch(0.98 0.02 185)",
        sidebarAccent: "oklch(0.95 0.05 185)",
      },
      dark: {
        primary: "oklch(0.75 0.12 185)",
        secondary: "oklch(0.25 0.05 185)",
        accent: "oklch(0.65 0.18 185)",
        sidebar: "oklch(0.22 0.08 185)",
        sidebarAccent: "oklch(0.60 0.15 185)",
      },
    },
  },
  {
    id: "lemon-lime",
    name: "Lemon Lime",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.80 0.15 105)",
        secondary: "oklch(0.95 0.08 75)",
        accent: "oklch(0.70 0.20 105)",
        sidebar: "oklch(0.98 0.04 75)",
        sidebarAccent: "oklch(0.95 0.08 75)",
      },
      dark: {
        primary: "oklch(0.85 0.15 105)",
        secondary: "oklch(0.28 0.08 75)",
        accent: "oklch(0.75 0.20 105)",
        sidebar: "oklch(0.25 0.10 105)",
        sidebarAccent: "oklch(0.70 0.18 105)",
      },
    },
  },
  {
    id: "falling-leaves",
    name: "Falling Leaves",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.60 0.18 50)",
        secondary: "oklch(0.92 0.08 25)",
        accent: "oklch(0.70 0.22 50)",
        sidebar: "oklch(0.98 0.04 25)",
        sidebarAccent: "oklch(0.92 0.08 25)",
      },
      dark: {
        primary: "oklch(0.75 0.18 50)",
        secondary: "oklch(0.25 0.08 25)",
        accent: "oklch(0.65 0.22 50)",
        sidebar: "oklch(0.22 0.10 50)",
        sidebarAccent: "oklch(0.60 0.20 50)",
      },
    },
  },
  {
    id: "sunrise",
    name: "Sunrise",
    category: "fun-and-new",
    colors: {
      light: {
        primary: "oklch(0.70 0.20 60)",
        secondary: "oklch(0.95 0.08 30)",
        accent: "oklch(0.65 0.15 340)",
        sidebar: "oklch(0.98 0.04 30)",
        sidebarAccent: "oklch(0.95 0.08 30)",
      },
      dark: {
        primary: "oklch(0.80 0.20 60)",
        secondary: "oklch(0.25 0.08 30)",
        accent: "oklch(0.70 0.25 60)",
        sidebar: "oklch(0.22 0.10 60)",
        sidebarAccent: "oklch(0.65 0.22 60)",
      },
    },
  },
];

/**
 * Get theme by ID
 */
export function getThemeById(id: OrganizationTheme): Theme | undefined {
  return themes.find((theme) => theme.id === id);
}

/**
 * Get themes by category
 */
export function getThemesByCategory(category: Theme["category"]): Theme[] {
  return themes.filter((theme) => theme.category === category);
}

/**
 * Get all theme categories
 */
export function getThemeCategories(): Array<{
  id: Theme["category"];
  label: string;
}> {
  return [
    { id: "single-color", label: "Single Color" },
    { id: "vision-assistive", label: "Vision Assistive" },
    { id: "fun-and-new", label: "Fun and New" },
  ];
}

export const fontFamilyMap: Record<OrganizationCustomFont, string> = {
  lato: '"Lato", system-ui, sans-serif',
  inter: '"Inter", system-ui, sans-serif',
  "open-sans": '"Open Sans", system-ui, sans-serif',
  roboto: '"Roboto", system-ui, sans-serif',
  "source-sans-pro": '"Source Sans Pro", system-ui, sans-serif',
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
];

/**
 * Get font by ID
 */
export function getFontById(id: OrganizationCustomFont) {
  return fonts.find((font) => font.id === id);
}
