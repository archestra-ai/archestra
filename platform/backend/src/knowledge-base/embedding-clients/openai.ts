import { isNomicModel } from "@shared";
import OpenAI from "openai";
import type { EmbeddingApiResponse } from "./types";

export class OpenAIEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAIEmbeddingError";
  }
}

/**
 * Embed multiple texts using the OpenAI-compatible `/v1/embeddings` endpoint.
 * Works with OpenAI, Ollama, and any provider that exposes the OpenAI embeddings API.
 */
export async function callOpenAIEmbedding(params: {
  texts: string[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { texts, model, apiKey, baseUrl, dimensions } = params;

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl ?? undefined,
  });

  try {
    const response = await client.embeddings.create({
      model,
      input: texts,
      // Nomic models do not support the `dimensions` parameter.
      ...(dimensions !== undefined && !isNomicModel(model)
        ? { dimensions }
        : {}),
    });

    return {
      object: response.object,
      data: response.data.map((item) => ({
        object: item.object,
        embedding: item.embedding,
        index: item.index,
      })),
      model: response.model,
      usage: {
        prompt_tokens: response.usage.prompt_tokens,
        total_tokens: response.usage.total_tokens,
      },
    };
  } catch (err: unknown) {
    if (err instanceof OpenAI.APIError) {
      throw new OpenAIEmbeddingError(err.status ?? 500, err.message);
    }
    throw err;
  }
}
