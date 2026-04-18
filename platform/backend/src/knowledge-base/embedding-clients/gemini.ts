import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

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
 * Embed multiple inputs using the Google GenAI SDK's `embedContent` method.
 * Supports both text strings and inline images (multimodal), as well as
 * API key mode and Vertex AI mode (via `createGoogleGenAIClient`).
 *
 * TODO: Add support for audio and video modalities — gemini-embedding-2-preview
 * supports text, image, audio, video, and PDF inputs.
 *
 * Gemini's native embedding API does not report token usage, so `prompt_tokens`
 * and `total_tokens` are always 0.
 */
export async function callGeminiEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;

  const client = createGoogleGenAIClient(apiKey, "[GeminiEmbedding]", baseUrl);

  const modelId = getGeminiEmbeddingModelId(model);

  // Map EmbeddingInput[] to ContentListUnion (PartUnion[]).
  // Strings pass through as-is; image inputs become Part objects with inlineData.
  const contents = inputs.map((input) => {
    if (typeof input === "string") return input;
    return { inlineData: { mimeType: input.mimeType, data: input.data } };
  });

  try {
    // The installed @google/genai SDK accepts multiple contents here. In API
    // key mode it routes to batchEmbedContents; for Vertex, gemini-embedding-001
    // is handled via the predict path and still supports batched inputs.
    const response = await client.models.embedContent({
      model: modelId,
      contents,
      config: dimensions ? { outputDimensionality: dimensions } : undefined,
    });
    const embeddings = response.embeddings?.map((item) => item.values ?? []);

    if (!embeddings?.length || embeddings.length !== inputs.length) {
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

function getGeminiEmbeddingModelId(model: string): string {
  if (isVertexAiEnabled()) {
    return model.replace(/^models\//, "");
  }

  return model.startsWith("models/") ? model : `models/${model}`;
}
