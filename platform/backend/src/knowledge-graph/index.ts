import type {
  KnowledgeGraphProvider,
  KnowledgeGraphProviderType,
  LightragConfig,
} from "@/types/knowledge-graph";

import { LightRAGProvider } from "./lightrag-provider";

export type {
  KnowledgeGraphProvider,
  KnowledgeGraphProviderType,
} from "@/types/knowledge-graph";
export { LightRAGProvider } from "./lightrag-provider";

/**
 * Create a knowledge graph provider instance based on provider type and config.
 * The config parameter is the provider-specific configuration (e.g., LightragConfig).
 */
export function createKnowledgeGraphProvider(
  providerType: KnowledgeGraphProviderType,
  providerConfig: LightragConfig,
): KnowledgeGraphProvider {
  switch (providerType) {
    case "lightrag":
      return new LightRAGProvider(providerConfig);
    default:
      throw new Error(`Unknown knowledge graph provider type: ${providerType}`);
  }
}
