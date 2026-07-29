import type { SupportedProvider } from "@archestra/shared";
import {
  type ModelsDevApiResponse,
  type ModelsDevModel,
  modelsDevCostToPerToken,
  sanitizeOutputLimit,
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
 * Crucially, the underlying vendor entry (e.g. `anthropic`) reliably carries
 * cache prices, which the region-keyed `amazon-bedrock` entry may omit.
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
  // Entries are ordered by preference (a vendor's canonical entry, which has
  // cache prices, before the region-keyed amazon-bedrock fallback).
  return pricesFromEntries(resolveCrossProviderEntries(params));
}

/**
 * Non-price capabilities carried by a reseller's matched registry entry.
 * Modalities stay as raw registry strings: they are unvalidated third-party
 * input, so the caller validates them against the same schema the column uses.
 */
export interface CrossProviderMetadata {
  contextLength: number | null;
  outputLength: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  supportsToolCalling: boolean | null;
}

/**
 * Resolve non-price capabilities for Bedrock/Azure, whose model ids never match
 * models.dev keys directly.
 *
 * Preference deliberately inverts {@link resolveCrossProviderPrices}: cost reads
 * the vendor's canonical entry first because only that reliably carries cache
 * prices, while limits and modalities read the reseller's entry first because
 * the reseller's numbers are the ones that apply. Claude Sonnet 4.5 forces the
 * split — Anthropic publishes a 1M window, Bedrock serves 200K, and both
 * entries carry identical prices.
 *
 * Resolved per field, so a reseller entry that omits one value still falls back
 * to the vendor's for that value alone.
 */
export function resolveCrossProviderMetadata(params: {
  provider: SupportedProvider;
  modelId: string;
  underlyingModelName?: string | null;
  modelsDevData: ModelsDevApiResponse;
}): CrossProviderMetadata | null {
  return metadataFromEntries(resolveCrossProviderEntries(params));
}

/**
 * Registry match for a model recorded by the LLM proxy, which names the
 * endpoint's provider rather than the model's own.
 *
 * A client may send any model name to any gateway endpoint, so the stored
 * provider is the endpoint's. Provider-scoped resolution then matches nothing
 * and the model falls to the fabricated default estimate even when the registry
 * lists it plainly -- an OpenAI model reaching a Bedrock endpoint is priced at
 * $50/M against a published $2.50.
 *
 * The provider-scoped match is still preferred, because a reseller's own entry
 * carries the price and limits that actually apply. Only when nothing matches
 * does this fall back to looking the bare id up among the vendors that make
 * models, deliberately skipping resellers and aggregators: they republish each
 * other's models at their own margins, so matching one would trade a wrong
 * price for a differently wrong price.
 */
export function resolveDiscoveredModelRegistryEntry(params: {
  provider: SupportedProvider;
  modelId: string;
  underlyingModelName?: string | null;
  modelsDevData: ModelsDevApiResponse;
}): {
  prices: CrossProviderPrices | null;
  metadata: CrossProviderMetadata | null;
} | null {
  const scoped = resolveCrossProviderEntries(params);
  const entries = scoped.length
    ? scoped
    : toArray(
        findFirstPartyRegistryEntry(params.modelId, params.modelsDevData),
      );
  if (!entries.length) {
    return null;
  }
  return {
    prices: pricesFromEntries(entries),
    metadata: metadataFromEntries(entries),
  };
}

/**
 * Strip a trailing date stamp from a model id, in either the contiguous Bedrock
 * form (`-20250929`) or the hyphenated OpenAI/Azure form (`-2024-08-06`).
 *
 * A bare four-digit suffix is deliberately left alone: Mistral versions models
 * as `-2407`/`-2411`, so stripping it would collapse two differently-priced
 * models onto one registry key.
 */
/**
 * Describe a model a self-hosted server serves, without asserting anything
 * about the deployment.
 *
 * An operator names a model whatever they like, so the id is a HuggingFace path
 * (`meta-llama/Llama-3.1-8B-Instruct`) far more often than a registry key
 * (`meta/llama-3.1-8b-instruct`); matching on the trailing segment is what
 * bridges the two. Nothing else here does that, deliberately — the shared
 * first-party lookup backs the proxy-discovery path, where a looser match would
 * begin asserting prices for models an operator merely named.
 *
 * Only modalities and tool support are reported. Prices belong to whoever
 * serves the model, and the context window is set when the server is launched:
 * registry entries for one model range over an order of magnitude precisely
 * because each host chooses its own.
 *
 * Returns null unless every match agrees on the modalities, so an alias that
 * collides with an unrelated vendor model reports nothing rather than something
 * plausible.
 */
export function resolveSelfHostedModelMetadata(params: {
  modelId: string;
  modelsDevData: ModelsDevApiResponse;
}): CrossProviderMetadata | null {
  const { modelId, modelsDevData } = params;
  const wanted = bareModelName(modelId);
  if (!wanted) {
    return null;
  }

  const matches: ModelsDevModel[] = [];
  for (const modelsDevProviderId of FIRST_PARTY_REGISTRY_PROVIDERS) {
    const models = modelsDevData[modelsDevProviderId]?.models ?? {};
    for (const [key, model] of Object.entries(models)) {
      if (bareModelName(model.id ?? key) === wanted) {
        matches.push(model);
      }
    }
  }
  if (matches.length === 0) {
    return null;
  }

  const readings = new Set(
    matches.map((entry) => JSON.stringify(entry.modalities?.input ?? null)),
  );
  if (readings.size > 1) {
    return null;
  }

  const metadata = metadataFromEntries(matches);
  return metadata && { ...metadata, contextLength: null, outputLength: null };
}

export function stripModelDateSuffix(modelId: string): string {
  return modelId.replace(DATE_SUFFIX, "");
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Registry entries matching a reseller model, in cost preference order (the
 * vendor's canonical entry first, the reseller's own entry second).
 */
function resolveCrossProviderEntries(params: {
  provider: SupportedProvider;
  modelId: string;
  underlyingModelName?: string | null;
  modelsDevData: ModelsDevApiResponse;
}): ModelsDevModel[] {
  const { provider, modelId, underlyingModelName, modelsDevData } = params;

  // Prefer the foundation-model id resolved from the profile's model ARN; fall
  // back to parsing the inference-profile id (system/cross-region profiles
  // encode it, application profiles do not).
  const targets =
    provider === "bedrock"
      ? resolveBedrockTargets(underlyingModelName ?? modelId)
      : provider === "azure"
        ? toArray(resolveAzureTarget(underlyingModelName ?? modelId))
        : [];

  const entries: ModelsDevModel[] = [];
  for (const target of targets) {
    const entry = findModelsDevModel({
      modelsDevData,
      modelsDevProviderId: target.modelsDevProviderId,
      candidates: target.candidates,
    });
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function firstPresent<T>(
  entries: ModelsDevModel[],
  pick: (entry: ModelsDevModel) => T | null | undefined,
): T | null {
  for (const entry of entries) {
    const value = pick(entry);
    if (value != null) {
      return value;
    }
  }
  return null;
}

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

function resolveBedrockTargets(modelId: string): CrossProviderTarget[] {
  const withoutRegion = modelId.replace(BEDROCK_REGION_PREFIX, "");
  const firstDot = withoutRegion.indexOf(".");
  if (firstDot === -1) {
    return [];
  }

  const targets: CrossProviderTarget[] = [];
  const vendor = withoutRegion.slice(0, firstDot).toLowerCase();
  const rawModel = withoutRegion.slice(firstDot + 1);

  // Strategy 1 (preferred): the vendor's canonical models.dev entry, which
  // carries cache prices (notably Anthropic). Matched on the canonical model id
  // (region + version + date stripped).
  const canonicalProvider = BEDROCK_VENDOR_TO_MODELS_DEV_PROVIDER[vendor];
  if (canonicalProvider) {
    const canonical = rawModel.replace(BEDROCK_VERSION_SUFFIX, "");
    targets.push({
      modelsDevProviderId: canonicalProvider,
      candidates: dedupe([canonical, stripModelDateSuffix(canonical)]),
    });
  }

  // Strategy 2 (fallback): the `amazon-bedrock` entry, keyed by the Bedrock
  // model id itself. Recovers input/output (and some cache_read, e.g. Nova) for
  // vendors whose Bedrock id doesn't map cleanly to a canonical key (Meta,
  // Amazon, DeepSeek, ...). Matched region-agnostically on the full id, so the
  // version suffix is kept (amazon-bedrock keys retain it).
  targets.push({
    modelsDevProviderId: "amazon-bedrock",
    candidates: dedupe([withoutRegion, stripModelDateSuffix(withoutRegion)]),
  });

  return targets;
}

function resolveAzureTarget(modelName: string): CrossProviderTarget | null {
  const canonical = modelName.trim().toLowerCase();
  if (!canonical) {
    return null;
  }
  // Azure hosts OpenAI models; their canonical pricing lives under `openai`.
  return {
    modelsDevProviderId: "openai",
    candidates: dedupe([canonical, stripModelDateSuffix(canonical)]),
  };
}

/**
 * Look up a model in a specific models.dev provider entry. Tries the candidates
 * as exact keys first, then matches any key whose region-prefix-stripped and/or
 * date-stripped form equals a candidate. Candidates are already region-stripped,
 * so this handles dated-vs-dateless keys and the amazon-bedrock entry's
 * region-prefixed keys (`us.meta.…` / `meta.…`) uniformly.
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
    const normalized = key.replace(BEDROCK_REGION_PREFIX, "");
    if (
      candidateSet.has(normalized) ||
      candidateSet.has(stripModelDateSuffix(normalized))
    ) {
      return model;
    }
  }

  return null;
}

function pricesFromEntries(
  entries: ModelsDevModel[],
): CrossProviderPrices | null {
  const entry = entries.find((e) => e.cost);
  return entry?.cost ? modelsDevCostToPerToken(entry.cost) : null;
}

function metadataFromEntries(
  entries: ModelsDevModel[],
): CrossProviderMetadata | null {
  const ordered = [...entries].reverse();
  const [preferred] = ordered;
  if (!preferred) {
    return null;
  }

  return {
    // Limits come from the preferred entry alone. Falling back to the next entry
    // for a missing limit would reintroduce the overstatement this ordering
    // exists to prevent: a reseller row that omits `limit.context` would publish
    // the vendor's larger window -- Anthropic's 1M for a model Bedrock serves at
    // 200K -- and an inflated window over-allocates the output budget and admits
    // requests the reseller rejects. Unknown is reported as null instead.
    contextLength: preferred.limit?.context ?? null,
    outputLength: sanitizeOutputLimit(preferred.limit?.output),
    // Modalities and tool support carry no such risk, so a reseller row that
    // omits them still benefits from the vendor's values.
    inputModalities: firstPresent(ordered, (entry) =>
      entry.modalities?.input?.length ? entry.modalities.input : null,
    ),
    outputModalities: firstPresent(ordered, (entry) =>
      entry.modalities?.output?.length ? entry.modalities.output : null,
    ),
    supportsToolCalling: firstPresent(ordered, (entry) => entry.tool_call),
  };
}

/**
 * models.dev providers that publish their own models, in preference order.
 * Resellers and aggregators are excluded on purpose: they list other vendors'
 * models at their own rates, so a match there asserts a price the caller is not
 * being charged.
 */
const FIRST_PARTY_REGISTRY_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "meta",
  "mistral",
  "deepseek",
  "xai",
  "cohere",
  "moonshotai",
  "minimax",
  "alibaba",
  "nvidia",
];

function findFirstPartyRegistryEntry(
  modelId: string,
  modelsDevData: ModelsDevApiResponse,
): ModelsDevModel | null {
  const candidates = dedupe([modelId, stripModelDateSuffix(modelId)]);
  for (const modelsDevProviderId of FIRST_PARTY_REGISTRY_PROVIDERS) {
    const entry = findModelsDevModel({
      modelsDevData,
      modelsDevProviderId,
      candidates,
    });
    if (entry) {
      return entry;
    }
  }
  return null;
}

/** The model's own name, with any owner prefix and casing removed. */
function bareModelName(modelId: string): string {
  return modelId.split("/").at(-1)?.trim().toLowerCase() ?? "";
}

function toArray<T>(value: T | null): T[] {
  return value == null ? [] : [value];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
