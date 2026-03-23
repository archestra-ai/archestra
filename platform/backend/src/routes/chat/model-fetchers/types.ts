import type { SupportedProvider } from "@shared";
import type { ModelCapabilities } from "@/types";

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
) => Promise<ModelInfo[]>;
