import type { SupportedProvider } from "@archestra/shared";
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
  /** Provider-reported default generation parameters (Ollama `/api/show`). */
  defaultParameters?: ModelDefaultParameters | null;
  /**
   * Total parameter count reported by the serving backend (Ollama `/api/show`).
   * Null/undefined for every provider that does not report one — which is all of
   * them except Ollama, vLLM included (its `ModelCard` carries no size field).
   */
  parameterCount?: number | null;
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

export type ModelFetcher = (
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
) => Promise<ModelInfo[]>;
