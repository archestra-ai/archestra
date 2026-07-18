import { embedMany } from "ai";
import { buildBedrockProvider } from "@/clients/bedrock-credentials";
import { findBedrockEmbeddingModel } from "./bedrock-models";
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
 * Embed text using AWS Bedrock's Amazon Titan Text Embeddings, reusing the same
 * credential resolution (IAM/IRSA, static SigV4, or bearer key) as Bedrock chat
 * via `buildBedrockProvider`. Titan is text-only.
 *
 * Only Titan v1/v2 are accepted. Cohere-on-Bedrock is a fast-follow (it needs an
 * input-type/purpose parameter and a different batch limit). The hard allowlist
 * also stops a Bedrock model that an admin mislabeled as embedding-capable (a
 * chat model, a Cohere model) from reaching a client that can't correctly drive
 * it — it fails fast with an actionable message instead of a confusing runtime
 * error.
 */
export async function callBedrockEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;

  const embeddingModel = findBedrockEmbeddingModel(model);
  if (!embeddingModel) {
    throw new BedrockEmbeddingError(
      400,
      `Bedrock embedding model "${model}" is not supported. Configure Amazon Titan Text Embeddings ` +
        `in Settings → Knowledge.`,
    );
  }

  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new BedrockEmbeddingError(
      400,
      "Amazon Titan embeddings do not support image inputs. Configure a multimodal embedding model to embed images.",
    );
  });

  const provider = buildBedrockProvider({ apiKey, baseUrl });

  // Titan v2 accepts an on-request output dimension (256/512/1024); Titan v1 is
  // fixed and rejects the parameter. Only forward a dimension the model both
  // supports and the SDK accepts.
  const providerOptions =
    embeddingModel.supportsDimensionsParam &&
    dimensions !== undefined &&
    BEDROCK_ON_REQUEST_DIMENSIONS.has(dimensions)
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
    const message = err instanceof Error ? err.message : String(err);
    throw new BedrockEmbeddingError(status, message);
  }
}

// ===== Internal constants =====

/** Output dimensions the AI SDK accepts on-request for Titan v2. */
const BEDROCK_ON_REQUEST_DIMENSIONS = new Set([256, 512, 1024]);

/** Bound Titan's per-input fan-out (one InvokeModel call per value). */
const BEDROCK_EMBEDDING_MAX_PARALLEL = 8;
