import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { FetchedModelCapabilities, ModelInfo } from "./types";

const OpenRouterGenerationModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      created: z.number().optional(),
      context_length: z.number().optional(),
      pricing: z
        .object({
          prompt: z.string().optional(),
          completion: z.string().optional(),
          input_cache_read: z.string().optional(),
          input_cache_write: z.string().optional(),
        })
        .partial()
        .optional(),
      supported_parameters: z.array(z.string()).optional(),
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
      url: joinBaseUrl(baseUrl, "/models"),
      apiKey,
      errorLabel: "OpenRouter models",
      extraHeaders,
      schema: OpenRouterGenerationModelsResponseSchema,
    }),
    fetchModelsWithBearerAuth({
      url: joinBaseUrl(baseUrl, "/embeddings/models"),
      apiKey,
      errorLabel: "OpenRouter embedding models",
      extraHeaders,
      schema: OpenRouterEmbeddingModelsResponseSchema,
    }),
  ]);

  if (generationResult.status === "rejected") {
    throw generationResult.reason;
  }

  // Embedding models override generation models on id collision (last write wins).
  const modelsById = new Map<string, ModelInfo>();
  for (const model of generationResult.value.data) {
    modelsById.set(model.id, toGenerationModelInfo(model));
  }

  if (embeddingResult.status === "fulfilled") {
    for (const model of embeddingResult.value.data) {
      modelsById.set(model.id, toEmbeddingModelInfo(model));
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

  return Array.from(modelsById.values());
}

function toGenerationModelInfo(model: OpenRouterGenerationModel): ModelInfo {
  return {
    id: model.id,
    displayName: model.name ?? model.id,
    provider: "openrouter",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
    capabilities: toFetchedCapabilities(model),
  };
}

function toEmbeddingModelInfo(model: OpenRouterEmbeddingModel): ModelInfo {
  return {
    id: model.id,
    displayName: model.name ?? model.id,
    provider: "openrouter",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  };
}

/**
 * Map OpenRouter's per-model metadata into the generic fetcher capability shape.
 * OpenRouter already reports pricing as per-token USD strings. Returns undefined
 * when the response carries no metadata, so models.dev enrichment still applies.
 */
function toFetchedCapabilities(
  model: OpenRouterGenerationModel,
): FetchedModelCapabilities | undefined {
  if (
    model.pricing == null &&
    model.context_length == null &&
    model.supported_parameters == null
  ) {
    return undefined;
  }

  return {
    contextLength: model.context_length ?? null,
    supportsToolCalling: model.supported_parameters
      ? model.supported_parameters.some(
          (param) => param === "tools" || param === "tool_choice",
        )
      : null,
    promptPricePerToken: normalizePrice(model.pricing?.prompt),
    completionPricePerToken: normalizePrice(model.pricing?.completion),
    cacheReadPricePerToken: normalizePrice(model.pricing?.input_cache_read),
    cacheWritePricePerToken: normalizePrice(model.pricing?.input_cache_write),
  };
}

/**
 * OpenRouter reports a negative per-token price (e.g. "-1") for its dynamic
 * routers, where the real cost depends on the model the request is routed to.
 * Treat that as unknown pricing rather than a literal negative price.
 */
function normalizePrice(price: string | undefined): string | null {
  if (price == null) {
    return null;
  }
  return Number(price) < 0 ? null : price;
}
