/**
 * Format a US-dollar amount for display: two decimals, thousands grouped
 * (2054.4463 -> "$2,054.45").
 *
 * For spend totals and summaries. Per-interaction log costs and per-token
 * prices keep their own, more precise formatting.
 *
 * A non-zero amount too small to survive rounding reads as "<$0.01" rather
 * than "$0.00", so a small charge is not mistaken for no charge.
 */
export function formatCurrency(value: number): string {
  if (value > 0 && value < MIN_DISPLAYED_AMOUNT) return "<$0.01";
  return usdFormatter.format(value);
}

// Below half a cent, two-decimal rounding would print "$0.00".
const MIN_DISPLAYED_AMOUNT = 0.005;

// Locale pinned so grouping matches the "$" prefix used across the app.
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
