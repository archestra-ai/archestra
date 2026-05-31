import type { SupportedEmbeddingDimension } from "@shared";
import { SUPPORTED_EMBEDDING_DIMENSIONS, TimeInMs } from "@shared";
import { Ollama, type ShowResponse } from "ollama";

import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import type { ModelInputModality, ModelOutputModality } from "@/types";

interface OllamaCapabilities {
  contextLength: number | null;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  supportsToolCalling: boolean | null;
}

class OllamaClient {
  // Cache raw show responses so inferCapabilities and inferEmbeddingDimensions
  // share one API call per model per sync run.
  private readonly showCache = new LRUCacheManager<ShowResponse>({
    maxSize: 200,
    defaultTtl: TimeInMs.Hour,
  });

  async inferCapabilities(
    modelId: string,
    baseUrl?: string | null,
  ): Promise<OllamaCapabilities> {
    const show = await this.show(modelId, baseUrl);
    if (!show) {
      return {
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportsToolCalling: null,
      };
    }

    const caps = show.capabilities ?? [];
    const isEmbedding = caps.includes("embedding");
    const hasVision = caps.includes("vision");
    const supportsTools = caps.includes("tools");

    const contextLength =
      OllamaClient.modelInfo(show)?.["llama.context_length"] ?? null;

    const inputModalities: ModelInputModality[] =
      hasVision && !isEmbedding ? ["text", "image"] : ["text"];

    return {
      contextLength: typeof contextLength === "number" ? contextLength : null,
      inputModalities,
      outputModalities: ["text"],
      supportsToolCalling: isEmbedding ? false : supportsTools,
    };
  }

  async inferEmbeddingDimensions(
    modelId: string,
    baseUrl?: string | null,
  ): Promise<SupportedEmbeddingDimension | null> {
    const show = await this.show(modelId, baseUrl);
    if (!show) {
      return null;
    }

    // Embedding dimension is stored under an architecture-specific key, e.g.
    // "llama.embedding_length", "bert.embedding_length", etc.
    const rawEmbeddingLength = Object.entries(
      OllamaClient.modelInfo(show) ?? {},
    ).find(([key]) => key.endsWith(".embedding_length"))?.[1];

    return SUPPORTED_EMBEDDING_DIMENSIONS.includes(
      rawEmbeddingLength as SupportedEmbeddingDimension,
    )
      ? (rawEmbeddingLength as SupportedEmbeddingDimension)
      : null;
  }

  // model_info is typed as Map<string, any> in the ollama package but is a
  // plain object at runtime — TypeScript disallows changing existing property
  // types via module augmentation, so the cast is isolated here.
  private static modelInfo(show: ShowResponse): Record<string, unknown> {
    return show.model_info as unknown as Record<string, unknown>;
  }

  private async show(
    modelId: string,
    baseUrl?: string | null,
  ): Promise<ShowResponse | null> {
    const cacheKey = `${baseUrl ?? config.llm.ollama.baseUrl}:${modelId}`;
    const cached = this.showCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const host = (baseUrl ?? config.llm.ollama.baseUrl).replace(/\/v1\/?$/, "");
    const client = new Ollama({ host });

    logger.info({ modelId, baseUrl }, "[Ollama client] Fetching model info");

    try {
      const response = await client.show({ model: modelId });
      this.showCache.set(cacheKey, response);
      return response;
    } catch (error) {
      logger.warn(
        {
          modelId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "[Ollama client] Failed to fetch Ollama model info via show API",
      );
      return null;
    }
  }
}

export const ollamaClient = new OllamaClient();
