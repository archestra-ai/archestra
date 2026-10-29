/** Tier order shared with router-core: index 0 is fast, 2 is smart. */
export const TIER_NAMES = ["fast", "normal", "smart"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/** One palette for every tier mark: the theme's chart slots 1–3, as a CSS colour and Tailwind classes. */
export const TIER_COLOR: Record<
  TierName,
  { css: string; dot: string; region: string; swatch: string }
> = {
  fast: {
    css: "var(--chart-1)",
    dot: "fill-chart-1",
    region: "fill-chart-1/20",
    swatch: "bg-chart-1",
  },
  normal: {
    css: "var(--chart-2)",
    dot: "fill-chart-2",
    region: "fill-chart-2/20",
    swatch: "bg-chart-2",
  },
  smart: {
    css: "var(--chart-3)",
    dot: "fill-chart-3",
    region: "fill-chart-3/20",
    swatch: "bg-chart-3",
  },
};
