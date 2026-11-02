import { z } from "zod";
import type { ProviderModelPricing } from "@/types/provider-model-pricing";
import { joinBaseUrl } from "@/utils/base-url";

/** Optional LiteLLM metadata; an OpenAI-compatible server need not implement it. */
export async function fetchLiteLlmMetadata(params: {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<{
  prices: Map<string, ProviderModelPricing>;
  outputLimits: Map<string, number | null>;
}> {
  const prices = new Map<string, ProviderModelPricing>();
  const outputLimits = new Map<string, number | null>();
  const result = { prices, outputLimits };
  const ambiguous = new Set<string>();
  if (new URL(params.baseUrl).origin === "https://api.openai.com")
    return result;
  try {
    const response = await fetch(joinBaseUrl(params.baseUrl, "/model/info"), {
      headers: {
        ...params.extraHeaders,
        Authorization: `Bearer ${params.apiKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    // Metadata access can be restricted even when /models and inference work.
    // Never log its body: it can contain provider configuration and secrets.
    if (!response.ok) return result;
    const parsed = ResponseSchema.safeParse(await response.json());
    if (!parsed.success) return result;
    for (const entry of parsed.data.data) {
      if (!entry.model_name) continue;
      const info = entry.model_info ?? {};
      const outputLimit = readOutputTokenLimit(info.max_output_tokens) ?? null;
      const previousLimit = outputLimits.get(entry.model_name);
      // A routed alias can land on any deployment. Use the smallest stated
      // limit, or leave it unknown if any deployment omits a valid limit.
      outputLimits.set(
        entry.model_name,
        previousLimit === undefined
          ? outputLimit
          : previousLimit === null || outputLimit === null
            ? null
            : Math.min(previousLimit, outputLimit),
      );
      const price = {
        promptPricePerToken: normalizePrice(info.input_cost_per_token),
        completionPricePerToken: normalizePrice(info.output_cost_per_token),
        cacheReadPricePerToken: normalizePrice(
          info.cache_read_input_token_cost,
        ),
        cacheWritePricePerToken: normalizePrice(
          info.cache_creation_input_token_cost,
        ),
      };
      // A routed alias can have several deployments. A single rate is only
      // authoritative when all deployments agree, including missing fields.
      if (
        prices.has(entry.model_name) &&
        JSON.stringify(prices.get(entry.model_name)) !== JSON.stringify(price)
      ) {
        ambiguous.add(entry.model_name);
      }
      prices.set(entry.model_name, price);
    }
    for (const id of ambiguous)
      prices.set(id, {
        promptPricePerToken: null,
        completionPricePerToken: null,
        cacheReadPricePerToken: null,
        cacheWritePricePerToken: null,
      });
  } catch {
    // Timeout, invalid JSON and non-LiteLLM endpoints keep ordinary discovery.
  }
  return result;
}

/** Only provider-published positive integers that fit the stored integer column. */
export function readOutputTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
    ? value
    : undefined;
}

function normalizePrice(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (
    typeof value === "string" &&
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : null;
}

const ResponseSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string().optional(),
      model_info: z
        .object({
          max_output_tokens: z.unknown().optional(),
          input_cost_per_token: z.unknown().optional(),
          output_cost_per_token: z.unknown().optional(),
          cache_read_input_token_cost: z.unknown().optional(),
          cache_creation_input_token_cost: z.unknown().optional(),
        })
        .nullish(),
    }),
  ),
});
