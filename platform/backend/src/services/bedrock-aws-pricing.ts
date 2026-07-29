import type { SupportedProvider } from "@archestra/shared";
import awsPricesJson from "./bedrock-aws-prices.json";

/**
 * Per-million token prices transcribed from the AWS Price List, read by identity
 * rather than by the JSON's literal shape.
 *
 * Derived from the public, credential-free offer documents
 * `pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock` and
 * `.../AmazonBedrockFoundationModels` (Anthropic bills as a marketplace listing
 * and appears only in the latter), scoped to us-east-1 via each offer's
 * `region_index.json`. Refreshing means re-reading those documents; AWS has
 * published roughly monthly.
 *
 * Three rules govern the transcription, each of which is easy to get wrong:
 * a price is published per 1K *or* per 1M tokens and both appear in one
 * document; `batch`, `flex`, `priority` and latency-optimized SKUs sit beside
 * the standard on-demand price and must not be read as it; and a `_Global`
 * suffix on the usage type marks the cheaper global-endpoint price.
 * A `|global` suffix marks the global-endpoint price; `out` is absent for models
 * AWS prices on input alone.
 */
const AWS_PRICES: Record<string, { in?: number; out?: number } | undefined> =
  awsPricesJson;

/**
 * Per-token prices for a Bedrock model, taken from the AWS Price List.
 * Strings for precision, matching how prices are stored.
 */
export interface BedrockAwsPrices {
  promptPricePerToken: string;
  completionPricePerToken: string;
}

/**
 * Bedrock model id (region prefix and trailing `:N` revision removed) to the
 * name AWS prices it under.
 *
 * A map is needed because AWS identifies a priced model by display name, and
 * inconsistently: most vendors appear as `Llama 3.2 90B`, Anthropic listings as
 * `Claude Sonnet 4.5 (Amazon Bedrock Edition)`, and embeddings under a separate
 * attribute with a third convention (`TitanEmbeddingsV2-Text-input`). No rule
 * derives one from the other, so the correspondence is stated.
 *
 * Keys keep the `-vN` segment: for Amazon it is part of the model name, not a
 * revision, and `titan-embed-text-v1` and `-v2` are different models priced five
 * times apart.
 */
const AWS_PRICE_IDENTITY: Record<string, string> = {
  "amazon.nova-2-lite-v1": "Nova 2.0 Lite",
  "amazon.nova-2-sonic-v1": "Nova Sonic 2.0",
  "amazon.nova-lite-v1": "Nova Lite",
  "amazon.nova-micro-v1": "Nova Micro",
  "amazon.nova-premier-v1": "Nova Premier",
  "amazon.nova-pro-v1": "Nova Pro",
  "amazon.titan-embed-text-v1": "Titan Embeddings G1 Text",
  "amazon.titan-embed-text-v2": "TitanEmbeddingsV2-Text-input",
  "anthropic.claude-3-haiku-20240307-v1": "Claude 3 Haiku",
  "anthropic.claude-3-sonnet-20240229-v1": "Claude 3 Sonnet",
  "anthropic.claude-fable-5": "Claude",
  "anthropic.claude-haiku-4-5-20251001-v1": "Claude Haiku 4.5",
  "anthropic.claude-opus-4-1-20250805-v1": "Claude Opus 4.1",
  "anthropic.claude-opus-4-5-20251101-v1": "Claude Opus 4.5",
  "anthropic.claude-opus-4-6-v1": "Claude Opus 4.6",
  "anthropic.claude-opus-4-7": "Claude Opus 4",
  "anthropic.claude-opus-4-8": "Claude Opus 4",
  "anthropic.claude-opus-5": "Claude",
  "anthropic.claude-sonnet-4-20250514-v1": "Claude Sonnet 4",
  "anthropic.claude-sonnet-4-5-20250929-v1": "Claude Sonnet 4.5",
  "anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6",
  "anthropic.claude-sonnet-5": "Claude",
  "deepseek.r1-v1": "R1",
  "deepseek.v3.2": "DeepSeek v3.2",
  "google.gemma-3-12b-it": "Gemma 3 12B",
  "google.gemma-3-27b-it": "Gemma 3 27B",
  "google.gemma-3-4b-it": "Gemma 3 4B",
  "meta.llama3-1-70b-instruct-v1": "Llama 3.1 70B",
  "meta.llama3-1-8b-instruct-v1": "Llama 3.1 8B",
  "meta.llama3-2-11b-instruct-v1": "Llama 3.2 11B",
  "meta.llama3-2-1b-instruct-v1": "Llama 3.2 1B",
  "meta.llama3-2-3b-instruct-v1": "Llama 3.2 3B",
  "meta.llama3-2-90b-instruct-v1": "Llama 3.2 90B",
  "meta.llama3-3-70b-instruct-v1": "Llama 3.3 70B",
  "meta.llama3-70b-instruct-v1": "Llama 3 70B",
  "meta.llama3-8b-instruct-v1": "Llama 3 8B",
  "meta.llama4-maverick-17b-instruct-v1": "Llama 4 Maverick 17B",
  "meta.llama4-scout-17b-instruct-v1": "Llama 4 Scout 17B",
  "minimax.minimax-m2": "Minimax M2",
  "minimax.minimax-m2.1": "Minimax M2.1",
  "minimax.minimax-m2.5": "MiniMax M2.5",
  "mistral.devstral-2-123b": "Devstral",
  "mistral.magistral-small-2509": "Magistral Small 1.2",
  "mistral.ministral-3-14b-instruct": "Ministral 14B 3.0",
  "mistral.ministral-3-3b-instruct": "Ministral 3B 3.0",
  "mistral.ministral-3-8b-instruct": "Ministral 8B 3.0",
  "mistral.mistral-7b-instruct-v0": "Mistral 7B",
  "mistral.mistral-large-2402-v1": "Mistral Large",
  "mistral.mistral-large-3-675b-instruct": "Mistral Large 3",
  "mistral.mistral-small-2402-v1": "Mistral Small",
  "mistral.mixtral-8x7b-instruct-v0": "Mixtral 8x7B",
  "mistral.pixtral-large-2502-v1": "Pixtral Large 25.02",
  "mistral.voxtral-mini-3b-2507": "Voxtral Mini 1.0",
  "mistral.voxtral-small-24b-2507": "Voxtral Small 1.0",
  "moonshot.kimi-k2-thinking": "Kimi K2 Thinking",
  "moonshotai.kimi-k2.5": "Kimi K2.5",
  "nvidia.nemotron-nano-12b-v2": "NVIDIA Nemotron Nano 2 VL",
  "nvidia.nemotron-nano-3-30b": "Nemotron Nano 3 30B",
  "nvidia.nemotron-nano-9b-v2": "NVIDIA Nemotron Nano 2",
  "nvidia.nemotron-super-3-120b": "NVIDIA Nemotron 3 Super 120B A12B",
  "openai.gpt-oss-120b-1": "gpt-oss-120b",
  "openai.gpt-oss-20b-1": "gpt-oss-20b",
  "openai.gpt-oss-safeguard-120b": "GPT OSS Safeguard 120B",
  "openai.gpt-oss-safeguard-20b": "GPT OSS Safeguard 20B",
  "qwen.qwen3-32b-v1": "Qwen3 32B",
  "qwen.qwen3-coder-30b-a3b-v1": "Qwen3 Coder 30B A3B",
  "qwen.qwen3-coder-next": "Qwen3 Coder Next",
  "qwen.qwen3-next-80b-a3b": "Qwen3 Next 80B A3B",
  "qwen.qwen3-vl-235b-a22b": "Qwen3 VL 235B A22B",
  "writer.palmyra-vision-7b": "Writer Palmyra Vision 7B",
  "writer.palmyra-x4-v1": "Palmyra X4",
  "writer.palmyra-x5-v1": "Palmyra X5",
  "zai.glm-4.7": "GLM 4.7",
  "zai.glm-4.7-flash": "GLM 4.7 Flash",
  "zai.glm-5": "GLM 5",
};

/** Trailing Bedrock revision (`:0`), which never forms part of a price identity. */
const REVISION_SUFFIX = /:\d+$/;
const REGION_PREFIX = /^(us-gov|us|eu|apac|ap|sa|ca|global)\./;
/** Bedrock routes `global.`-prefixed profiles to global endpoints, priced below regional ones. */
const GLOBAL_PREFIX = "global.";

/**
 * Resolve a Bedrock model's per-token prices from the vendored AWS Price List
 * snapshot.
 *
 * Returns null when the id maps to no priced identity, leaving the caller to
 * fall back. No fuzzy matching: a model priced as the wrong model is worse than
 * one that is visibly unpriced.
 */
export function resolveBedrockAwsPrices(params: {
  provider: SupportedProvider;
  modelId: string;
  underlyingModelName?: string | null;
}): BedrockAwsPrices | null {
  const { provider, modelId, underlyingModelName } = params;
  if (provider !== "bedrock") {
    return null;
  }

  // The foundation-model id from the profile's ARN is authoritative; an
  // application inference profile's own id encodes nothing.
  const source = underlyingModelName ?? modelId;
  const identity =
    AWS_PRICE_IDENTITY[normalizeBedrockModelId(source)] ??
    (source === modelId
      ? undefined
      : AWS_PRICE_IDENTITY[normalizeBedrockModelId(modelId)]);
  if (!identity) {
    return null;
  }

  // A regional profile falls back to the global price when AWS publishes only
  // one tier for the model.
  const wantsGlobal =
    stripRegion(source).isGlobal || stripRegion(modelId).isGlobal;
  const entry = wantsGlobal
    ? (AWS_PRICES[`${identity}|global`] ?? AWS_PRICES[identity])
    : (AWS_PRICES[identity] ?? AWS_PRICES[`${identity}|global`]);
  if (!entry || entry.in === undefined) {
    return null;
  }

  // AWS prices embeddings on input alone; those models bill no output tokens.
  const output = entry.out ?? 0;
  return {
    promptPricePerToken: perToken(entry.in),
    completionPricePerToken: perToken(output),
  };
}

function perToken(perMillion: number): string {
  return Number.parseFloat((perMillion / 1_000_000).toFixed(12)).toString();
}

function stripRegion(modelId: string): { rest: string; isGlobal: boolean } {
  return {
    rest: modelId.replace(REGION_PREFIX, ""),
    isGlobal: modelId.startsWith(GLOBAL_PREFIX),
  };
}

function normalizeBedrockModelId(modelId: string): string {
  return stripRegion(modelId).rest.replace(REVISION_SUFFIX, "");
}
