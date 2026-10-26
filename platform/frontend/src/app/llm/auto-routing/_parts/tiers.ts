/** Tier order shared with router-core: index 0 is fast, 2 is smart. */
export const TIER_NAMES = ["fast", "normal", "smart"] as const;
export type TierName = (typeof TIER_NAMES)[number];
