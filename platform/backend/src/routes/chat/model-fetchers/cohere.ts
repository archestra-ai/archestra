import config from "@/config";
import { COHERE_EMBEDDING_MODELS } from "@/knowledge-base/embedding-clients/cohere-models";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

/**
 * Cohere's `/v2/models` lists chat and embed models alike (each with its
 * `endpoints`). Chat/generate and native rerank models are surfaced with their
 * executable endpoint. Embed models come
 * from the KB's static capability table instead: the listing reports neither
 * dimensions nor modalities, so only models the Cohere embedding client can
 * drive are offered, tagged with their dimension — and they are offered even
 * when the listing omits them, so a key scoped to embeddings still sees them.
 */
export async function fetchCohereModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cohere.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    models: Array<{
      name: string;
      endpoints?: string[];
      created_at?: string;
    }>;
  }>({
    url: joinBaseUrl(baseUrl, "/v2/models"),
    apiKey,
    errorLabel: "Cohere models",
    extraHeaders,
  });

  const chatModels: ModelInfo[] = data.models
    .filter((model) => {
      const endpoints = model.endpoints || [];
      return endpoints.includes("chat") || endpoints.includes("generate");
    })
    .map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: "cohere" as const,
      createdAt: model.created_at,
    }))
    .sort((a, b) => {
      const preferredModel = "command-r-08-2024";
      if (a.id === preferredModel) return -1;
      if (b.id === preferredModel) return 1;
      return a.id.localeCompare(b.id);
    });

  // The listing only contributes `created_at`; the table decides what is
  // offered and at which dimension.
  const listedEmbedCreatedAt = new Map(
    data.models
      .filter((model) => (model.endpoints || []).includes("embed"))
      .map((model) => [model.name, model.created_at] as const),
  );
  const embeddingModels: ModelInfo[] = COHERE_EMBEDDING_MODELS.map((entry) => ({
    id: entry.modelId,
    displayName: entry.displayName,
    provider: "cohere" as const,
    createdAt: listedEmbedCreatedAt.get(entry.modelId),
    capabilities: { embeddingDimensions: entry.dimensions },
  }));

  const rerankModels: ModelInfo[] = data.models
    .filter((model) => (model.endpoints || []).includes("rerank"))
    .map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: "cohere" as const,
      createdAt: model.created_at,
      capabilities: { supportedEndpoints: ["/rerank"] },
    }));

  return [...chatModels, ...embeddingModels, ...rerankModels];
}
