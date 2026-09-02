import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { ModelInputModalitySchema, ModelOutputModalitySchema } from "@/types";
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
      architecture: z
        .object({
          input_modalities: z.array(z.string()).optional(),
          output_modalities: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
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
    model.supported_parameters == null &&
    model.architecture == null
  ) {
    return undefined;
  }

  return {
    contextLength: model.context_length ?? null,
    inputModalities: parseModalities(
      model.architecture?.input_modalities,
      ModelInputModalitySchema,
      OPENROUTER_INPUT_MODALITY_ALIASES,
    ),
    outputModalities: parseModalities(
      model.architecture?.output_modalities,
      ModelOutputModalitySchema,
    ),
    supportsToolCalling: model.supported_parameters
      ? model.supported_parameters.some(
          (param) => param === "tools" || param === "tool_choice",
        )
      : null,
    // `reasoning` and not `reasoning_effort`: the former is the parameter the
    // chat route actually sends, and it is the wider of the two — every model
    // listing `reasoning_effort` also lists `reasoning`, while a large share of
    // reasoning models list only `reasoning` because their upstream takes a
    // token budget that OpenRouter derives from the effort. Gating on the
    // narrower field would hide the control on models that honor it.
    supportsReasoningEffort: model.supported_parameters
      ? model.supported_parameters.includes("reasoning")
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

/**
 * OpenRouter names the document modality `file`; the rest of the platform uses
 * models.dev's vocabulary, where it is `pdf`. Every other value already matches.
 */
const OPENROUTER_INPUT_MODALITY_ALIASES: Record<string, string> = {
  file: "pdf",
};

/**
 * Validate OpenRouter's modality strings against our enum, dropping anything we
 * do not model (e.g. `video` on the output side). Returns null when the block is
 * absent or nothing survives, so sync falls through to the registry instead of
 * storing an empty list.
 */
function parseModalities<T>(
  modalities: string[] | undefined,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  aliases: Record<string, string> = {},
): T[] | null {
  if (modalities == null || modalities.length === 0) {
    return null;
  }
  const validated: T[] = [];
  for (const modality of modalities) {
    const result = schema.safeParse(aliases[modality] ?? modality);
    if (result.success && result.data !== undefined) {
      validated.push(result.data);
    }
  }
  return validated.length > 0 ? validated : null;
}
