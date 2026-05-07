import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

const OpenRouterGenerationModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      created: z.number().optional(),
    }),
  ),
});

const OpenRouterEmbeddingModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      created: z.number().optional(),
    }),
  ),
});

type OpenRouterGenerationModel = z.infer<
  typeof OpenRouterGenerationModelsResponseSchema
>["data"][number];
type OpenRouterEmbeddingModel = z.infer<
  typeof OpenRouterEmbeddingModelsResponseSchema
>["data"][number];

export async function fetchOpenrouterModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.openrouter.baseUrl;
  const [generationResult, embeddingResult] = await Promise.allSettled([
    fetchModelsWithBearerAuth({
      url: `${baseUrl}/models`,
      apiKey,
      errorLabel: "OpenRouter models",
      extraHeaders,
      schema: OpenRouterGenerationModelsResponseSchema,
    }),
    fetchModelsWithBearerAuth({
      url: `${baseUrl}/embeddings/models`,
      apiKey,
      errorLabel: "OpenRouter embedding models",
      extraHeaders,
      schema: OpenRouterEmbeddingModelsResponseSchema,
    }),
  ]);

  if (generationResult.status === "rejected") {
    throw generationResult.reason;
  }

  const modelsById = new Map<
    string,
    OpenRouterGenerationModel | OpenRouterEmbeddingModel
  >();
  for (const model of generationResult.value.data) {
    modelsById.set(model.id, model);
  }

  if (embeddingResult.status === "fulfilled") {
    for (const model of embeddingResult.value.data) {
      modelsById.set(model.id, model);
    }
  } else {
    logger.warn(
      {
        errorMessage:
          embeddingResult.reason instanceof Error
            ? embeddingResult.reason.message
            : String(embeddingResult.reason),
      },
      "Failed to fetch OpenRouter embedding models, continuing with generation models",
    );
  }

  return Array.from(modelsById.values()).map((model) => ({
    id: model.id,
    displayName: "name" in model && model.name ? model.name : model.id,
    provider: "openrouter",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}
