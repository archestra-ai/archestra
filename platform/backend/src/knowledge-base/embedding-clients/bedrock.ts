import { embedMany } from "ai";
import { buildBedrockProvider } from "@/clients/bedrock-credentials";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

export class BedrockEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BedrockEmbeddingError";
  }
}

/**
 * Embed text using AWS Bedrock, reusing the same credential resolution (IAM/IRSA,
 * static SigV4, or bearer key) as Bedrock chat via `buildBedrockProvider`.
 *
 * Like every other embedding client, this attempts the embed and surfaces the
 * provider's own error — it does not pre-screen the model. Titan v2 accepts an
 * on-request output dimension (256/512/1024); Titan v1 is fixed and rejects the
 * parameter, so a dimension is only forwarded when it is one Titan v2 accepts.
 */
export async function callBedrockEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;

  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new BedrockEmbeddingError(
      400,
      "Selected model doesn't support embedding image inputs. Use a multimodal embedding model to embed images.",
    );
  });

  const provider = buildBedrockProvider({ apiKey, baseUrl });

  // Titan v2 accepts an on-request output dimension (256/512/1024); Titan v1 (and
  // any model with a fixed dimension) rejects the parameter. Forward the dimension
  // only when it is one Titan v2 accepts; otherwise let the model use its default.
  const providerOptions =
    dimensions !== undefined && BEDROCK_ON_REQUEST_DIMENSIONS.has(dimensions)
      ? { bedrock: { dimensions } }
      : undefined;

  try {
    const { embeddings, usage } = await embedMany({
      model: provider.embeddingModel(model),
      values: texts,
      // Titan embeds one input per InvokeModel call, so embedMany fans out one
      // request per value — bound the concurrency.
      maxParallelCalls: BEDROCK_EMBEDDING_MAX_PARALLEL,
      // The KB embedder owns retries/backoff (see callEmbeddingApiWithRetry);
      // disable the SDK's inner retry loop so a failure isn't retried twice.
      maxRetries: 0,
      ...(providerOptions ? { providerOptions } : {}),
    });

    return {
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model,
      usage: {
        prompt_tokens: usage?.tokens ?? 0,
        total_tokens: usage?.tokens ?? 0,
      },
    };
  } catch (err: unknown) {
    if (err instanceof BedrockEmbeddingError) {
      throw err;
    }
    const status =
      (err as { statusCode?: number; status?: number }).statusCode ??
      (err as { statusCode?: number; status?: number }).status ??
      500;
    // The AI SDK formats every Bedrock error as `${error.type}: ${error.message}`;
    // Bedrock validation errors carry no `type`, so the message arrives prefixed
    // with a literal "undefined: ". Drop that artifact so the raw provider message
    // reads cleanly.
    const message = (err instanceof Error ? err.message : String(err)).replace(
      /^undefined:\s*/,
      "",
    );
    throw new BedrockEmbeddingError(status, message);
  }
}

// ===== Internal constants =====

/** Output dimensions the AI SDK accepts on-request for Titan v2. */
const BEDROCK_ON_REQUEST_DIMENSIONS = new Set([256, 512, 1024]);

/** Bound Titan's per-input fan-out (one InvokeModel call per value). */
const BEDROCK_EMBEDDING_MAX_PARALLEL = 8;
