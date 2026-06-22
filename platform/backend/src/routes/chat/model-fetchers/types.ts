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
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
  capabilities?: FetchedModelCapabilities;
}

export type ModelFetcher = (
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
) => Promise<ModelInfo[]>;
