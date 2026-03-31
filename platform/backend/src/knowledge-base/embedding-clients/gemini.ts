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

  // The installed @google/genai SDK only exposes embedContent here, so each
  // text is embedded individually for now. Revisit batchEmbedContents if the
  // SDK surface or observed rate limits make that worthwhile.
  const embeddings = await Promise.all(
    texts.map(async (text) => {
      try {
        const response = await client.models.embedContent({
          model: modelId,
          contents: text,
          config: dimensions ? { outputDimensionality: dimensions } : undefined,
        });
        const embedding = response.embeddings?.[0]?.values;
        if (!embedding?.length) {
          throw new GeminiEmbeddingError(
            500,
            "Gemini embedding response did not include embedding values",
          );
        }
        return embedding;
      } catch (err: unknown) {
        if (err instanceof GeminiEmbeddingError) {
          throw err;
        }
        const status =
          (err as { status?: number; httpStatusCode?: number }).status ??
          (err as { status?: number; httpStatusCode?: number })
            .httpStatusCode ??
          500;
        throw new GeminiEmbeddingError(
          status,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );

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
}
