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
  const parsed = Number(price);
  // `Number("")` is 0, which would render a missing price as free.
  if (price.trim() === "" || !Number.isFinite(parsed)) {
    return price;
  }
  // 8 decimals matches the precision the API formats to, so nothing is lost.
  const significant = parsed.toFixed(8).replace(/0+$/, "");
  const decimals = significant.split(".")[1]?.length ?? 0;
  return parsed.toFixed(Math.max(2, decimals));
}

interface MediaRate {
  kind: "text" | "image" | "audio" | "text_and_image";
  usd: number;
}

/**
 * Render a media model's rates as "input / output", each rate named by what it
 * meters: an image model bills text and image tokens apart, a speech model per
 * character, a Whisper-style model per minute of audio.
 */
export function formatMediaPricing(pricing: {
  per: "million_tokens" | "million_characters" | "minute";
  input: MediaRate[];
  output: MediaRate[];
}): string {
  const rate = ({ kind, usd }: MediaRate) =>
    `$${formatPricePerMillion(String(usd))}${kind === "text_and_image" ? "" : ` ${kind}`}`;
  if (pricing.per === "minute")
    return `$${formatPricePerMillion(String(pricing.input[0]?.usd ?? 0))} / min`;
  if (pricing.per === "million_characters")
    return `$${formatPricePerMillion(String(pricing.input[0]?.usd ?? 0))} / 1M chars`;
  const input = pricing.input.map(rate).join(" · ") || "-";
  const output = pricing.output.map(rate).join(" · ") || "-";
  return `${input} / ${output}`;
}
