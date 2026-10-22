import { isNomicModel } from "@archestra/shared";
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
  headers?: Record<string, string>;
  /** Reads the billed cost from the raw `usage` block, for providers that report one. */
  readReportedCost?: (rawUsage: unknown) => number | undefined;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions, headers } = params;
  // OpenAI-compatible APIs are text-only: reject non-text inputs.
  // Images should never reach here because connectors only ingest images when
  // the embedding model's inputModalities includes "image", which OpenAI models don't.
  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new OpenAIEmbeddingError(
      400,
      "OpenAI-compatible embedding APIs do not support image inputs. " +
        "Configure a multimodal embedding model (e.g. gemini-embedding-2) to embed images.",
    );
  });

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl ?? undefined,
    defaultHeaders: headers,
  });

  try {
    const response = await client.embeddings.create({
      model,
      input: texts,
      // Requested explicitly so the SDK returns the raw payload: its implicit
      // base64 decode garbles the float arrays that providers ignoring
      // `encoding_format` send back. `decodeEmbedding` accepts both shapes.
      encoding_format: "base64",
      // Nomic models do not support the `dimensions` parameter.
      ...(dimensions !== undefined && !isNomicModel(model)
        ? { dimensions }
        : {}),
    });

    // Guard every field: an endpoint that speaks a non-OpenAI dialect can return
    // a body without `data`/`usage`. Never dereference blindly (the historical
    // `response.data.map` crash) — return what is present and let the dispatcher's
    // central validation raise a typed, actionable error.
    const data = Array.isArray(response.data) ? response.data : [];
    const reportedCost = params.readReportedCost?.(response.usage);
    return {
      object: response.object ?? "list",
      data: data.map((item) => ({
        object: item.object,
        embedding: decodeEmbedding(item.embedding),
        index: item.index,
      })),
      model: response.model ?? model,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
        ...(reportedCost === undefined ? {} : { cost: reportedCost }),
      },
    };
  } catch (err: unknown) {
    if (err instanceof OpenAI.APIError) {
      throw new OpenAIEmbeddingError(err.status ?? 500, err.message);
    }
    throw err;
  }
}

// === Internal helpers

/**
 * Normalize one embedding to a number array. OpenAI returns little-endian
 * float32 bytes as base64; some OpenAI-compatible providers ignore
 * `encoding_format` and return a JSON number array instead. Anything else is
 * returned as-is for the dispatcher's validation to reject.
 */
function decodeEmbedding(embedding: unknown): number[] {
  if (typeof embedding !== "string") return embedding as number[];
  const bytes = Buffer.from(embedding, "base64");
  // Copy into a fresh, aligned buffer: a pooled Buffer can have a byteOffset
  // that is not a multiple of 4, which a Float32Array view would reject.
  const aligned = new Uint8Array(bytes).buffer;
  return Array.from(
    new Float32Array(
      aligned,
      0,
      Math.floor(aligned.byteLength / Float32Array.BYTES_PER_ELEMENT),
    ),
  );
}
