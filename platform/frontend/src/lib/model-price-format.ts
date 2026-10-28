import { normalizeModelPrice } from "@archestra/shared/model-price";

/**
 * Render a per-million token price with at least two decimal places.
 * Prices in the custom range use the stored eight-decimal rounding, trimming
 * trailing zeros beyond two places: `2.50000000` becomes `2.50`, while
 * `0.00600000` stays `0.006` rather than rounding to a cent.
 *
 * Other finite prices use the fixed-notation fallback to count significant
 * decimals, including values sent in exponential form. Unparseable input is
 * returned unchanged.
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
