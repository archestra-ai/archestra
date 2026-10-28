import { normalizeModelPrice } from "@archestra/shared/model-price";

/**
 * Render a per-million token price for display.
 *
 * The API sends prices at full precision because cost is computed from them, so
 * a cent-rounded string would be a billing error rather than a rounding choice.
 * That leaves a bare `2.5` where a price column wants `2.50`, and a genuinely
 * sub-cent price like `0.035` that must not be flattened to `0.04`. Pad to two
 * decimals, keep any beyond that.
 *
 * Significant decimals are counted off a fixed-notation copy rather than the
 * incoming string, which arrives in exponential form for the smallest prices.
 */
export function formatPricePerMillion(price: string): string {
  const stored = normalizeModelPrice(price);
  if (stored !== null) {
    const [whole, fraction] = stored.split(".");
    return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
  }
  const parsed = Number(price);
  // `Number("")` is 0, which would render a missing price as free.
  if (price.trim() === "" || !Number.isFinite(parsed)) {
    return price;
  }
  // Provider-published rates outside the custom-price range keep their formatting.
  const significant = parsed.toFixed(8).replace(/0+$/, "");
  const decimals = significant.split(".")[1]?.length ?? 0;
  return parsed.toFixed(Math.max(2, decimals));
}
