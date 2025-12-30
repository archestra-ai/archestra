export type ErrorExtended = {
  message: string;
  request?: {
    method: string;
    url: string;
  };
  data?: object;
  stack?: string;
};

/**
 * Supported secrets manager types
 */
export enum SecretsManagerType {
  DB = "DB",
  Vault = "Vault",
  /** BYOS (Bring Your Own Secrets) - Vault with external team folder support */
  BYOS_VAULT = "BYOS_VAULT",
}

export type OrganizationTheme =
  | "zinc"
  | "slate"
  | "stone"
  | "gray"
  | "neutral"
  | "red"
  | "rose"
  | "orange"
  | "green"
  | "blue"
  | "violet"
  | "modern-minimal"
  | "t3-chat"
  | "twitter"
  | "mocha-mousse"
  | "bubblegum"
  | "doom-64"
  | "catppuccin"
  | "graphite"
  | "perpetuity"
  | "kodama-grove"
  | "cosmic-night"
  | "tangerine"
  | "quantum-rose"
  | "nature"
  | "bold-tech"
  | "elegant-luxury"
  | "amber-minimal"
  | "supabase"
  | "neo-brutalism"
  | "solar-dusk"
  | "claymorphism"
  | "cyberpunk"
  | "pastel-dreams"
  | "clean-slate"
  | "caffeine"
  | "ocean-breeze"
  | "retro-arcade"
  | "midnight-bloom"
  | "candyland"
  | "northern-lights"
  | "vintage-paper"
  | "sunset-horizon"
  | "starry-night"
  | "claude"
  | "vercel"
  | "mono";

export type OrganizationCustomFont =
  | "lato"
  | "inter"
  | "open-sans"
  | "roboto"
  | "source-sans-pro";
