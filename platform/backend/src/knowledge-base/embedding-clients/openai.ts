import { isNomicModel } from "@shared";
import OpenAI from "openai";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

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
 * Embed multiple inputs using the OpenAI-compatible `/v1/embeddings` endpoint.
 * Works with OpenAI, Ollama, and any provider that exposes the OpenAI embeddings API.
 *
 * OpenAI-compatible providers support text only. Non-text inputs (images)
 * will throw — they should never reach this client in normal operation.
 */
export async function callOpenAIEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;
  // OpenAI-compatible APIs are text-only: reject non-text inputs.
  // Images should never reach here because connectors only ingest images when
  // the embedding model's inputModalities includes "image", which OpenAI models don't.
  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new OpenAIEmbeddingError(
      400,
      "OpenAI-compatible embedding APIs do not support image inputs. " +
        "Configure a multimodal embedding model (e.g. gemini-embedding-2-preview) to embed images.",
    );
  });

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
