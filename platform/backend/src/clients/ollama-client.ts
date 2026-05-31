import type { SupportedEmbeddingDimension } from "@shared";
import { SUPPORTED_EMBEDDING_DIMENSIONS, TimeInMs } from "@shared";
import { Ollama } from "ollama";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import type { ModelInputModality, ModelOutputModality } from "@/types";

interface OllamaModelCapabilities {
  contextLength: number | null;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  supportsToolCalling: boolean | null;
  embeddingDimensions: SupportedEmbeddingDimension | null;
}

class OllamaClient {
  private readonly cache = new LRUCacheManager<OllamaModelCapabilities>({
    maxSize: 200,
    defaultTtl: TimeInMs.Hour,
  });

  private getClient(baseUrl?: string | null): Ollama {
    const host = (baseUrl ?? config.llm.ollama.baseUrl).replace(/\/v1\/?$/, "");
    return new Ollama({ host });
  }

  /**
   * Fetches model capabilities via the Ollama `show` API.
   * Results are cached for 1 hour to avoid redundant calls during model sync.
   * Falls back to null fields on any error.
   */
  async inferModelCapabilities(
    modelId: string,
    baseUrl?: string | null,
  ): Promise<OllamaModelCapabilities> {
    const cacheKey = `${baseUrl ?? config.llm.ollama.baseUrl}:${modelId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const client = this.getClient(baseUrl);

    logger.info({ modelId, baseUrl }, "[Ollama client] Fetching model info");

    let showResponse: Awaited<ReturnType<Ollama["show"]>>;
    try {
      showResponse = await client.show({ model: modelId });
    } catch (error) {
      logger.warn(
        {
          modelId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "[Ollama client] Failed to fetch Ollama model info via show API",
      );
      return {
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportsToolCalling: null,
        embeddingDimensions: null,
      };
    }

    const caps = showResponse.capabilities ?? [];
    const isEmbedding = caps.includes("embedding");
    const hasVision = caps.includes("vision");
    const supportsTools = caps.includes("tools");

    // model_info is typed as Map<string, any> in the ollama package but is a
    // plain object at runtime — cast via unknown since Map and Record don't overlap.
    const modelInfo = showResponse.model_info as unknown as Record<
      string,
      unknown
    >;

    const contextLength = modelInfo?.["llama.context_length"] ?? null;

    // Embedding dimension is stored under an architecture-specific key, e.g.
    // "llama.embedding_length", "bert.embedding_length", etc.
    const rawEmbeddingLength = Object.entries(modelInfo ?? {}).find(([key]) =>
      key.endsWith(".embedding_length"),
    )?.[1];
    const embeddingDimensions = SUPPORTED_EMBEDDING_DIMENSIONS.includes(
      rawEmbeddingLength as SupportedEmbeddingDimension,
    )
      ? (rawEmbeddingLength as SupportedEmbeddingDimension)
      : null;

    const inputModalities: ModelInputModality[] =
      hasVision && !isEmbedding ? ["text", "image"] : ["text"];

    const result: OllamaModelCapabilities = {
      contextLength: typeof contextLength === "number" ? contextLength : null,
      inputModalities,
      outputModalities: ["text"],
      supportsToolCalling: isEmbedding ? false : supportsTools,
      embeddingDimensions,
    };

    this.cache.set(cacheKey, result);
    return result;
  }
}

export const ollamaClient = new OllamaClient();
