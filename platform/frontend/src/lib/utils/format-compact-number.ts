/**
 * Abbreviate a count for tight spaces: 999 -> "999", 1050 -> "1.1K",
 * 129984 -> "130K", 2500000 -> "2.5M".
 *
 * Locale is pinned so the suffixes stay the same K/M/B everywhere a count is
 * shown, whatever language the browser reports.
 */
export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
