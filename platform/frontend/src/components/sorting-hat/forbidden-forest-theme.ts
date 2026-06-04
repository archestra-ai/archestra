/**
 * Forbidden Forest Theme Variant
 *
 * A dark mode theme variant inspired by the Forbidden Forest.
 * Adds deep greens, misty grays, and subtle magical effects.
 */

export const forbiddenForestTheme = {
  name: "forbidden-forest",
  label: "Forbidden Forest",
  description: "A dark, mystical theme inspired by the Forbidden Forest",
  icon: "🌲",

  // CSS custom properties for the theme
  cssVariables: {
    "--theme-bg-primary": "#0a0f0a",
    "--theme-bg-secondary": "#111a11",
    "--theme-bg-tertiary": "#1a2a1a",
    "--theme-text-primary": "#e8f5e8",
    "--theme-text-secondary": "#a8c8a8",
    "--theme-text-muted": "#6a8a6a",
    "--theme-border": "#2a3a2a",
    "--theme-accent": "#4a8a4a",
    "--theme-accent-hover": "#5a9a5a",
    "--theme-danger": "#8a3a3a",
    "--theme-warning": "#8a7a3a",
    "--theme-success": "#3a8a4a",
    "--theme-info": "#3a6a8a",

    // Sorting Hat specific
    "--sorting-hat-glow": "rgba(74, 138, 74, 0.3)",
    "--sorting-hat-sparkle": "rgba(147, 197, 253, 0.6)",

    // Patronus glow
    "--patronus-glow": "rgba(147, 197, 253, 0.4)",
    "--patronus-core": "rgba(255, 255, 255, 0.9)",

    // Golden Snitch trail
    "--snitch-gold": "#FFD700",
    "--snitch-trail": "rgba(255, 215, 0, 0.3)",

    // Floo Network green flames
    "--floo-flame": "#00ff88",
    "--floo-glow": "rgba(0, 255, 136, 0.4)",
  },

  // Tailwind-compatible class mappings
  classes: {
    background: "bg-[#0a0f0a]",
    surface: "bg-[#111a11]",
    surfaceElevated: "bg-[#1a2a1a]",
    text: "text-[#e8f5e8]",
    textSecondary: "text-[#a8c8a8]",
    textMuted: "text-[#6a8a6a]",
    border: "border-[#2a3a2a]",
    accent: "bg-[#4a8a4a]",
    accentHover: "hover:bg-[#5a9a5a]",

    // Magical effects
    glow: "shadow-[0_0_20px_rgba(74,138,74,0.3)]",
    sparkle: "animate-sparkle",
    mist: "bg-gradient-to-b from-[#1a2a1a]/50 to-transparent",
  },

  // Animation keyframes for the theme
  animations: {
    sparkle: {
      "0%, 100%": { opacity: "0.3", transform: "scale(1)" },
      "50%": { opacity: "1", transform: "scale(1.2)" },
    },
    mist: {
      "0%": { opacity: "0.1", transform: "translateY(0)" },
      "50%": { opacity: "0.3", transform: "translateY(-5px)" },
      "100%": { opacity: "0.1", transform: "translateY(0)" },
    },
    firefly: {
      "0%, 100%": { opacity: "0", transform: "translate(0, 0)" },
      "25%": { opacity: "1", transform: "translate(5px, -5px)" },
      "50%": { opacity: "0.5", transform: "translate(-3px, -10px)" },
      "75%": { opacity: "1", transform: "translate(8px, -3px)" },
    },
  },
};

/**
 * Check if the current theme is Forbidden Forest.
 */
export function isForbiddenForestTheme(themeName: string): boolean {
  return themeName === "forbidden-forest";
}

/**
 * Get the appropriate loader component based on tool house assignment.
 */
export function getLoaderForHouse(house: string): "golden-snitch" | "default" {
  return house === "gryffindor" ? "golden-snitch" : "default";
}
