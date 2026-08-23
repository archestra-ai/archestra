/**
 * Shared formatting for the My Usage page.
 *
 * Token counts here run to the hundreds of millions, where a fully punctuated
 * number is read as a length rather than a value. Costs stay exact: they are
 * small, and rounding money is how a page stops being trusted.
 */

const compactTokens = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokens(tokens: number): string {
  return compactTokens.format(tokens);
}

export function formatCost(cost: number): string {
  // Sub-cent amounts are real at this granularity, and "$0.00" next to a
  // non-zero token count reads as a bug rather than as a small number.
  const decimals = cost !== 0 && Math.abs(cost) < 0.01 ? 4 : 2;
  return `$${cost.toFixed(decimals)}`;
}

/** `share` of `total` as a whole percentage, guarding the empty-timeframe 0/0. */
export function percentOf(share: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((share / total) * 100);
}

/**
 * A share as a label, distinguishing "none" from "too small to round to one
 * percent". Printing a real 0.3% band as "0%" next to a seven-figure token
 * count reads as a broken number rather than a small one.
 */
export function formatPercent(share: number, total: number): string {
  const rounded = percentOf(share, total);
  if (rounded === 0 && share > 0) return "<1%";
  return `${rounded}%`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
