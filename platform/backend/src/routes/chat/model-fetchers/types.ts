import type {
  ModelInputModality,
  ModelOutputModality,
  ReasoningEffortLevel,
  SupportedProvider,
  SupportedProviderEndpoint,
} from "@archestra/shared";
import type { AzureModelEvidence } from "@archestra/shared/azure-models";
import { ApiError } from "@/types/api";
import type { ModelDefaultParameters } from "@/types/model";
import type { ProviderModelPricing } from "@/types/provider-model-pricing";

export const PLACEHOLDER_API_KEY = "EMPTY";
export const PLACEHOLDER_BEARER_TOKEN = `Bearer ${PLACEHOLDER_API_KEY}`;

/**
 * Map a provider's model-listing failure to the error surfaced to the caller.
 * The upstream status is relayed for client errors (an invalid provider key is
 * a 401, not a crash of ours) and mapped to 502 for provider 5xx — either way
 * the failure carries its real classification instead of a generic 500.
 */
export function modelFetchError(
  label: string,
  upstreamStatus: number,
): ApiError {
  return new ApiError(
    upstreamStatus >= 500 ? 502 : upstreamStatus,
    `Failed to fetch ${label}: ${upstreamStatus}`,
  );
}

/**
 * Capabilities a fetcher can read straight from a provider's models endpoint.
 * Kept minimal and separate from the API-facing `ModelCapabilities`: a fetcher
 * only reports raw provider facts, not computed/price-source fields. Fed into
 * `resolveModelCapabilities` as the highest-priority tier during model sync,
 * except output limits, which are stored on the API-key/model link.
 */
export interface FetchedModelCapabilities {
  contextLength?: number | null;
  /** Maximum generation length published by the serving endpoint. */
  outputLength?: number | null;
  supportsToolCalling?: boolean | null;
  /**
   * What the model accepts / emits, when the provider publishes it per model
   * (OpenRouter's `architecture` block). The provider is authoritative about
   * its own catalog, so these outrank the registry during sync — and a
   * non-text output modality is what tells the "free" badge that a model's
   * zero per-token price is not the whole story. `undefined` means the
   * provider said nothing.
   */
  inputModalities?: ModelInputModality[] | null;
  outputModalities?: ModelOutputModality[] | null;
  /**
   * Whether the model accepts image input, when the provider says only that
   * (GitHub Copilot's `supports.vision`) rather than listing modalities. Sync
   * adds or removes `image` on the modalities the other tiers resolve, so a
   * registry's richer list (`pdf`, …) survives. `undefined` means unknown.
   */
  supportsVision?: boolean | null;
  /**
   * The fetcher classified this model from its id (OpenAI's media, audio
   * chat and search models), so sync overwrites what an earlier sync stored
   * instead of keeping it: a realtime model synced as a chat model by an
   * older build would otherwise stay one.
   */
  authoritative?: boolean;
  /**
   * The fetcher's `contextLength` is the provider's current limit for this
   * model, so sync replaces the stored window instead of only filling an empty
   * one. GitHub Copilot sets it: its windows grow with the API version and plan,
   * and a window from an older sync would otherwise stay forever. An
   * administrator's custom context window is a separate column and stays.
   */
  authoritativeContextLength?: boolean;
  promptPricePerToken?: string | null;
  completionPricePerToken?: string | null;
  /** Per-token cache-read price (USD), when the provider reports one. */
  cacheReadPricePerToken?: string | null;
  /** Per-token cache-write price (USD, default TTL), when the provider reports one. */
  cacheWritePricePerToken?: string | null;
  /**
   * Embedding classification when the provider reports capabilities authoritatively
   * (e.g. Ollama `/api/show`). Tri-state:
   * - `number` — authoritative embedding model with this native dimension.
   * - `null` — authoritatively NOT an embedding model; the name heuristic is skipped.
   * - `undefined` — unknown (provider gave no capability data); the name heuristic decides.
   */
  embeddingDimensions?: number | null;
  /**
   * Whether the model reasons, when the server says so authoritatively (Ollama
   * `/api/show` lists a `thinking` capability). Tri-state, like
   * {@link embeddingDimensions}: `undefined` means the server reported no
   * capability list at all, so a lower tier may still decide.
   */
  supportsReasoningEffort?: boolean | null;
  /** Provider-reported default generation parameters (Ollama `/api/show`). */
  defaultParameters?: ModelDefaultParameters | null;
  /**
   * Total parameter count reported by the serving backend (Ollama `/api/show`).
   * Null/undefined for every provider that does not report one — which is all of
   * them except Ollama, vLLM included (its `ModelCard` carries no size field).
   */
  parameterCount?: number | null;
  /**
   * Provider surfaces this model can be invoked through, when the provider
   * publishes that per model (GitHub Copilot's `supported_endpoints`). Needed
   * where a provider serves two wire formats off one catalog and the model id
   * does not reveal which: Copilot's Codex and GPT-5.x models accept only
   * `/responses`, while the rest accept only `/chat/completions`, and both
   * families use bare ids. `undefined` means the provider said nothing.
   */
  supportedEndpoints?: SupportedProviderEndpoint[] | null;
  /**
   * The `reasoning_effort` levels the provider says this model accepts
   * (GitHub Copilot's `supports.reasoning_effort`, the Codex catalog's
   * `supported_reasoning_levels`, LiteLLM's `supports_*_reasoning_effort`).
   * An empty array is the provider saying the model takes none; `undefined`
   * means it said nothing.
   */
  supportedReasoningEfforts?: ReasoningEffortLevel[] | null;
}

export interface ModelInfo {
  azureCapabilities?: AzureModelEvidence | null;
  /** Instance-local prices; never written to the shared model catalog. */
  providerPricing?: ProviderModelPricing;
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
  capabilities?: FetchedModelCapabilities;
  /**
   * Underlying vendor model name when the stored id is not the canonical model
   * name (e.g. an Azure deployment's backing model). Used to resolve pricing.
   */
  underlyingModelName?: string | null;
}

export interface StaticModel {
  id: string;
  displayName: string;
}

export interface ModelFetchOptions {
  /**
   * The llm_provider_api_keys row the credential came from, when it already
   * exists. Subscription-credential fetchers (ChatGPT/Codex, X Premium) pass it
   * to their token manager so a rotated refresh token is cached and persisted
   * back to the row — an ID-less redemption instead stashes the rotation for
   * `latestKnownRefreshToken`, which only helps within the same request.
   */
  providerApiKeyId?: string;
}

export type ModelFetcher = (
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
  opts?: ModelFetchOptions,
) => Promise<ModelInfo[]>;
