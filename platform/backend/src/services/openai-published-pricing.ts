import type { SupportedProvider } from "@archestra/shared";
import { stripModelDateSuffix } from "./cross-provider-pricing";

/**
 * Per-token prices for an OpenAI model, transcribed from OpenAI's price list.
 * Strings for precision, matching how prices are stored.
 */
export interface OpenAiPublishedPrices {
  promptPricePerToken: string;
  completionPricePerToken: string;
  cacheReadPricePerToken: string;
}

/**
 * Prices for OpenAI models the models.dev registry does not list.
 *
 * The registry carries the `gpt-5.3` generation onward but never backfilled the
 * Codex and `chat-latest` models before it, so each of these resolved to the
 * fabricated default estimate — $50/M against a published $1.25/M, and $30/M
 * against $0.25/M for `gpt-5.1-codex-mini`.
 *
 * Transcribed from <https://developers.openai.com/api/docs/pricing>, standard
 * tier. Refreshing means re-reading that page.
 *
 * Every id is stated outright rather than derived by stripping `-codex` to
 * reach a base model: the suffix predicts the price for `gpt-5.1-codex` but not
 * for `gpt-5.1-codex-mini`, which bills a fifth of what `gpt-5.1` does.
 */
const PUBLISHED_PRICES: Record<
  string,
  { in: number; cachedIn: number; out: number } | undefined
> = {
  // A bare id, not a typo: OpenAI lists the ChatGPT-latest alias under this
  // name, priced apart from the `gpt-5*-chat-latest` snapshots.
  "chat-latest": { in: 5, cachedIn: 0.5, out: 30 },
  "gpt-5-chat-latest": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5-codex": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-chat-latest": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex-max": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex-mini": { in: 0.25, cachedIn: 0.025, out: 2 },
  "gpt-5.2-codex": { in: 1.75, cachedIn: 0.175, out: 14 },
};

/**
 * Published prices for an OpenAI model, or null when the registry already
 * covers it or the model is unknown.
 *
 * Ranks below models.dev in the price ladder, so it can only fill a gap that
 * would otherwise reach the default estimate. A model the registry gains later
 * silently stops consulting this map.
 */
export function resolveOpenAiPublishedPrices(params: {
  provider: SupportedProvider;
  modelId: string;
}): OpenAiPublishedPrices | null {
  const { provider, modelId } = params;
  if (provider !== "openai") {
    return null;
  }

  const entry =
    PUBLISHED_PRICES[modelId] ??
    PUBLISHED_PRICES[stripModelDateSuffix(modelId)];
  if (!entry) {
    return null;
  }

  return {
    promptPricePerToken: perToken(entry.in),
    completionPricePerToken: perToken(entry.out),
    cacheReadPricePerToken: perToken(entry.cachedIn),
  };
}

/**
 * Model ids this map prices.
 *
 * @public — exported for the test asserting the registry has not caught up;
 * knip --production sees no other consumer.
 */
export const OPENAI_PUBLISHED_PRICE_IDS = Object.keys(PUBLISHED_PRICES);

function perToken(perMillion: number): string {
  return Number.parseFloat((perMillion / 1_000_000).toFixed(12)).toString();
}
