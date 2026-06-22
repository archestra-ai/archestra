import type { SupportedProvider } from "@archestra/shared";
import {
  type ModelsDevApiResponse,
  type ModelsDevModel,
  modelsDevCostToPerToken,
} from "@/clients/models-dev-client";

/**
 * Per-token prices resolved from a models.dev entry (strings for precision,
 * null when the registry omits that price).
 */
export interface CrossProviderPrices {
  promptPricePerToken: string | null;
  completionPricePerToken: string | null;
  cacheReadPricePerToken: string | null;
  cacheWritePricePerToken: string | null;
}

/**
 * Resolve pricing for providers whose model ids do not match models.dev keys
 * (AWS Bedrock and Azure), by mapping the id back to the underlying vendor model
 * and reading that vendor's models.dev entry.
 *
 * Why this is needed: Bedrock stores region-prefixed inference-profile ids
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Azure stores arbitrary
 * deployment names — neither matches the canonical `anthropic`/`openai` keys in
 * models.dev, so without this both always fall back to the flat default price.
 * Crucially, the underlying vendor entry (e.g. `anthropic`) also carries cache
 * prices that the region-keyed `amazon-bedrock` entry omits.
 *
 * Returns null when no confident match is found (caller keeps its existing
 * behaviour, i.e. the default price) — never guesses across unrelated models.
 */
export function resolveCrossProviderPrices(params: {
  provider: SupportedProvider;
  /** The id we store for the model (Bedrock inference-profile id / Azure deployment name). */
  modelId: string;
  /** Underlying vendor model name when known (e.g. Azure management `properties.model.name`). */
  underlyingModelName?: string | null;
  modelsDevData: ModelsDevApiResponse;
}): CrossProviderPrices | null {
  const { provider, modelId, underlyingModelName, modelsDevData } = params;

  const target =
    provider === "bedrock"
      ? // Prefer the foundation-model id resolved from the profile's model ARN;
        // fall back to parsing the inference-profile id (system/cross-region
        // profiles encode it, application profiles do not).
        resolveBedrockTarget(underlyingModelName ?? modelId)
      : provider === "azure"
        ? resolveAzureTarget(underlyingModelName ?? modelId)
        : null;

  if (!target) {
    return null;
  }

  const entry = findModelsDevModel({
    modelsDevData,
    modelsDevProviderId: target.modelsDevProviderId,
    candidates: target.candidates,
  });
  if (!entry?.cost) {
    return null;
  }

  return modelsDevCostToPerToken(entry.cost);
}

// ============================================================================
// Internal
// ============================================================================

interface CrossProviderTarget {
  /** The models.dev provider id whose entry hosts the canonical model. */
  modelsDevProviderId: string;
  /** Candidate model-id keys to try, in priority order. */
  candidates: string[];
}

/**
 * Bedrock vendor prefix (the segment after the optional region prefix) → the
 * models.dev provider id that carries the canonical model + its cache pricing.
 */
const BEDROCK_VENDOR_TO_MODELS_DEV_PROVIDER: Record<string, string> = {
  anthropic: "anthropic",
  meta: "meta",
  mistral: "mistral",
  cohere: "cohere",
  deepseek: "deepseek",
  ai21: "ai21",
};

const BEDROCK_REGION_PREFIX = /^(us-gov|us|eu|apac|ap|sa|ca|global)\./;
/** Trailing Bedrock model version, e.g. `-v1:0` or `:0`. */
const BEDROCK_VERSION_SUFFIX = /(?:-v\d+)?:\d+$/;
/**
 * Trailing date stamp in either the contiguous Bedrock form (`-20250929`) or
 * the hyphenated OpenAI/Azure form (`-2024-08-06`).
 */
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;

function resolveBedrockTarget(modelId: string): CrossProviderTarget | null {
  const withoutRegion = modelId.replace(BEDROCK_REGION_PREFIX, "");
  const firstDot = withoutRegion.indexOf(".");
  if (firstDot === -1) {
    return null;
  }

  const vendor = withoutRegion.slice(0, firstDot).toLowerCase();
  const modelsDevProviderId = BEDROCK_VENDOR_TO_MODELS_DEV_PROVIDER[vendor];
  if (!modelsDevProviderId) {
    return null;
  }

  const rawModel = withoutRegion.slice(firstDot + 1);
  const canonical = rawModel.replace(BEDROCK_VERSION_SUFFIX, "");
  return {
    modelsDevProviderId,
    candidates: dedupe([canonical, canonical.replace(DATE_SUFFIX, "")]),
  };
}

function resolveAzureTarget(modelName: string): CrossProviderTarget | null {
  const canonical = modelName.trim().toLowerCase();
  if (!canonical) {
    return null;
  }
  // Azure hosts OpenAI models; their canonical pricing lives under `openai`.
  return {
    modelsDevProviderId: "openai",
    candidates: dedupe([canonical, canonical.replace(DATE_SUFFIX, "")]),
  };
}

/**
 * Look up a model in a specific models.dev provider entry. Tries the candidates
 * as exact keys first, then matches any key whose date-stripped form equals a
 * candidate (handles dated-vs-dateless registry keys).
 */
function findModelsDevModel(params: {
  modelsDevData: ModelsDevApiResponse;
  modelsDevProviderId: string;
  candidates: string[];
}): ModelsDevModel | null {
  const { modelsDevData, modelsDevProviderId, candidates } = params;
  const models = modelsDevData[modelsDevProviderId]?.models;
  if (!models) {
    return null;
  }

  for (const candidate of candidates) {
    const exact = models[candidate];
    if (exact) {
      return exact;
    }
  }

  const candidateSet = new Set(candidates);
  for (const [key, model] of Object.entries(models)) {
    if (candidateSet.has(key.replace(DATE_SUFFIX, ""))) {
      return model;
    }
  }

  return null;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
