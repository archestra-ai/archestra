import type {
  ModelInputModality,
  ModelOutputModality,
  SupportedProvider,
  SupportedProviderEndpoint,
} from "@archestra/shared";
import { ApiError } from "@/types";
import type { ModelDefaultParameters } from "@/types/model";

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
 * `resolveModelCapabilities` as the highest-priority tier during model sync.
 */
export interface FetchedModelCapabilities {
  contextLength?: number | null;
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
}

export interface ModelInfo {
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
