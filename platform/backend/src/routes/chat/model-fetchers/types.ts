import type { SupportedProvider } from "@archestra/shared";

export const PLACEHOLDER_API_KEY = "EMPTY";
export const PLACEHOLDER_BEARER_TOKEN = `Bearer ${PLACEHOLDER_API_KEY}`;

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
