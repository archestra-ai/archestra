import type {
  KnowledgeBaseProvider,
  KnowledgeBaseProviderType,
  LightragConfig,
} from "@/types/knowledge-base";

import { LightRAGProvider } from "./lightrag-provider";

export type {
  KnowledgeBaseProvider,
  KnowledgeBaseProviderType,
} from "@/types/knowledge-base";
export { LightRAGProvider } from "./lightrag-provider";

/**
 * Create a knowledge base provider instance based on provider type and config.
 * The config parameter is the provider-specific configuration (e.g., LightragConfig).
 */
export function createKnowledgeBaseProvider(
  providerType: KnowledgeBaseProviderType,
  providerConfig: LightragConfig,
): KnowledgeBaseProvider {
  switch (providerType) {
    case "lightrag":
      return new LightRAGProvider(providerConfig);
    default:
      throw new Error(`Unknown knowledge base provider type: ${providerType}`);
  }
}
