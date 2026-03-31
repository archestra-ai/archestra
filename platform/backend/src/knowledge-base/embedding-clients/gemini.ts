import { createGoogleGenAIClient } from "@/clients/gemini-client";
import type { EmbeddingApiResponse } from "./types";

export class GeminiEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiEmbeddingError";
  }
}

/**
 * Embed multiple texts using the Google GenAI SDK's `embedContent` method.
 * Supports both API key mode and Vertex AI mode (via `createGoogleGenAIClient`).
 *
 * Gemini's native embedding API does not report token usage, so `prompt_tokens`
 * and `total_tokens` are always 0.
 */
export async function callGeminiEmbedding(params: {
  texts: string[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { texts, model, apiKey, baseUrl, dimensions } = params;

  const client = createGoogleGenAIClient(apiKey, "[GeminiEmbedding]", baseUrl);

  // Normalise to "models/gemini-embedding-001" format
  const modelId = model.startsWith("models/") ? model : `models/${model}`;

  try {
    // The installed @google/genai SDK accepts multiple contents here. In API
    // key mode it routes to batchEmbedContents; for Vertex, gemini-embedding-001
    // is handled via the predict path and still supports batched inputs.
    const response = await client.models.embedContent({
      model: modelId,
      contents: texts,
      config: dimensions ? { outputDimensionality: dimensions } : undefined,
    });
    const embeddings = response.embeddings?.map((item) => item.values ?? []);

    if (!embeddings?.length || embeddings.length !== texts.length) {
      throw new GeminiEmbeddingError(
        500,
        "Gemini embedding response did not include embeddings for each input",
      );
    }

    if (embeddings.some((embedding) => embedding.length === 0)) {
      throw new GeminiEmbeddingError(
        500,
        "Gemini embedding response did not include embedding values",
      );
    }

    return {
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  } catch (err: unknown) {
    if (err instanceof GeminiEmbeddingError) {
      throw err;
    }
    const status =
      (err as { status?: number; httpStatusCode?: number }).status ??
      (err as { status?: number; httpStatusCode?: number }).httpStatusCode ??
      500;
    const message =
      (err as { message?: string }).message ??
      (err instanceof Error ? err.message : String(err));
    throw new GeminiEmbeddingError(status, message);
  }
}
