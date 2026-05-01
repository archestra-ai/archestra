import type { SupportedProvider } from "@shared";
import type { ModelCapabilities } from "@/types";

export const PLACEHOLDER_API_KEY = "EMPTY";
export const PLACEHOLDER_BEARER_TOKEN = `Bearer ${PLACEHOLDER_API_KEY}`;

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
  capabilities?: ModelCapabilities;
}

export type ModelFetcher = (
  apiKey: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
) => Promise<ModelInfo[]>;
