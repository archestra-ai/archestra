import { embedMany } from "ai";
import type { BedrockClient } from "@/clients/bedrock-client";
import {
  buildBedrockClient,
  buildBedrockProvider,
} from "@/clients/bedrock-credentials";
import logger from "@/logging";
import { mapWithConcurrency } from "@/utils/concurrency";
import { getEncoding, truncateToTokens } from "../tokenizer";
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
 * Embed text and images using AWS Bedrock, reusing the same credential
 * resolution (IAM/IRSA, static SigV4, or bearer key) as Bedrock chat.
 *
 * Two request paths, dispatched on the configured model:
 *   - Multimodal models (Titan Multimodal G1, Cohere Embed v3) are driven over
 *     raw InvokeModel via `BedrockClient` — the AI SDK's Bedrock embedding path
 *     only produces text-shaped request bodies.
 *   - Everything else keeps the AI SDK `embedMany` path and rejects image
 *     inputs with a typed 400 naming the model.
 *
 * Like every other embedding client, this attempts the embed and surfaces the
 * provider's own error — it does not pre-screen whether the account/region
 * offers the model.
 */
export async function callBedrockEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;
  const entry = findBedrockEmbeddingModel(model);

  if (entry?.inputModalities.includes("image")) {
    const client = buildBedrockClient({ apiKey, baseUrl });
    try {
      const { embeddings, tokens } = entry.modelId.startsWith("cohere.")
        ? await embedWithCohere({ client, model, inputs })
        : await embedWithTitanMultimodal({
            client,
            model,
            inputs,
            dimensions,
            onRequestDimensions: entry.onRequestDimensions,
            maxInputTextTokens: entry.maxInputTextTokens,
          });
      return toEmbeddingApiResponse({ embeddings, tokens, model });
    } catch (err: unknown) {
      throw toBedrockEmbeddingError(err);
    }
  }

  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new BedrockEmbeddingError(
      400,
      `Model "${model}" doesn't support embedding image inputs. Use a multimodal embedding model (e.g. Amazon Titan Multimodal Embeddings G1) to embed images.`,
    );
  });

  const provider = buildBedrockProvider({ apiKey, baseUrl });

  // Titan v2 accepts an on-request output dimension (256/512/1024); Titan v1
  // (and any model with a fixed dimension) rejects the parameter. Forward the
  // dimension only when the model accepts it; an unknown model falls back to
  // the Titan v2 set so its behavior is unchanged.
  const acceptedDimensions =
    entry?.onRequestDimensions ?? DEFAULT_ON_REQUEST_DIMENSIONS;
  const providerOptions =
    dimensions !== undefined && acceptedDimensions.includes(dimensions)
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

    return toEmbeddingApiResponse({
      embeddings,
      tokens: usage?.tokens ?? 0,
      model,
    });
  } catch (err: unknown) {
    throw toBedrockEmbeddingError(err);
  }
}

// ===== Internal helpers =====

/**
 * Embed via Amazon Titan Multimodal Embeddings G1: one InvokeModel call per
 * input (the model takes a single text and/or image per request), body
 * `{inputText}` or `{inputImage: <base64>}` plus `embeddingConfig` when the
 * requested dimension is one the model accepts on request.
 *
 * Text inputs are truncated to the model's hard token limit (Titan MM takes
 * 256 text tokens and REJECTS over-limit input with a ValidationException —
 * there is no truncate parameter). The KB's default chunk is larger than
 * that, so without this an ordinary text chunk fails the whole batch.
 */
async function embedWithTitanMultimodal(params: {
  client: BedrockClient;
  model: string;
  inputs: EmbeddingInput[];
  dimensions?: number;
  onRequestDimensions?: readonly number[];
  maxInputTextTokens?: number;
}): Promise<{ embeddings: number[][]; tokens: number }> {
  const {
    client,
    model,
    inputs,
    dimensions,
    onRequestDimensions,
    maxInputTextTokens,
  } = params;

  const embeddingConfig =
    dimensions !== undefined && onRequestDimensions?.includes(dimensions)
      ? { embeddingConfig: { outputEmbeddingLength: dimensions } }
      : {};

  const prepared = truncateTextInputs({ inputs, model, maxInputTextTokens });

  let tokens = 0;
  const embeddings = await mapAllOrThrow(
    prepared,
    BEDROCK_EMBEDDING_MAX_PARALLEL,
    async (input) => {
      const body =
        typeof input === "string"
          ? { inputText: input, ...embeddingConfig }
          : { inputImage: input.data, ...embeddingConfig };
      const response = await client.invokeJson<{
        embedding?: number[];
        inputTextTokenCount?: number;
        /** Titan reports generation errors here, on an otherwise-200 response. */
        message?: string;
      }>(model, body);
      if (!Array.isArray(response.embedding)) {
        throw new BedrockEmbeddingError(
          500,
          response.message ??
            `Bedrock returned no embedding vector (model "${model}")`,
        );
      }
      tokens += response.inputTextTokenCount ?? 0;
      return response.embedding;
    },
  );

  return { embeddings, tokens };
}

/**
 * Embed via Cohere Embed v3 on Bedrock. Texts are batched (the API takes up to
 * 96 per call); each image is its own call (the API takes exactly one image per
 * request, as a data URI, under `input_type: "image"`). Results are reassembled
 * in input order. The invoke response carries no token usage.
 */
async function embedWithCohere(params: {
  client: BedrockClient;
  model: string;
  inputs: EmbeddingInput[];
}): Promise<{ embeddings: number[][]; tokens: number }> {
  const { client, model, inputs } = params;
  const embeddings = new Array<number[]>(inputs.length);

  const textEntries: Array<{ index: number; text: string }> = [];
  const imageEntries: Array<{ index: number; dataUri: string }> = [];
  inputs.forEach((input, index) => {
    if (typeof input === "string") {
      textEntries.push({ index, text: input });
      return;
    }
    assertCohereImageSize(input, model);
    imageEntries.push({
      index,
      dataUri: `data:${input.mimeType};base64,${input.data}`,
    });
  });

  const textBatches: Array<Array<{ index: number; text: string }>> = [];
  for (let i = 0; i < textEntries.length; i += COHERE_MAX_TEXTS_PER_CALL) {
    textBatches.push(textEntries.slice(i, i + COHERE_MAX_TEXTS_PER_CALL));
  }

  const calls: Array<() => Promise<void>> = [
    ...textBatches.map((batch) => async () => {
      const response = await client.invokeJson<CohereEmbeddingResponse>(model, {
        texts: batch.map((entry) => entry.text),
        input_type: "search_document",
        // A chunk slightly over the model's token limit degrades to a truncated
        // vector instead of failing the whole document.
        truncate: "END",
      });
      const vectors = cohereVectors(response, model, batch.length);
      batch.forEach((entry, i) => {
        embeddings[entry.index] = vectors[i];
      });
    }),
    ...imageEntries.map((entry) => async () => {
      const response = await client.invokeJson<CohereEmbeddingResponse>(model, {
        images: [entry.dataUri],
        input_type: "image",
      });
      embeddings[entry.index] = cohereVectors(response, model, 1)[0];
    }),
  ];

  await mapAllOrThrow(calls, BEDROCK_EMBEDDING_MAX_PARALLEL, (call) => call());

  return { embeddings, tokens: 0 };
}

/**
 * Cohere's embeddings arrive either as a bare array of vectors or keyed by
 * embedding type (`{float: [...]}`) depending on whether `embedding_types` was
 * sent — parse both defensively.
 */
interface CohereEmbeddingResponse {
  embeddings?: number[][] | { float?: number[][] };
}

function cohereVectors(
  response: CohereEmbeddingResponse,
  model: string,
  expectedCount: number,
): number[][] {
  const raw = response.embeddings;
  const vectors = Array.isArray(raw) ? raw : raw?.float;
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new BedrockEmbeddingError(
      500,
      `Bedrock returned ${Array.isArray(vectors) ? vectors.length : 0} embedding(s) for ${expectedCount} input(s) (model "${model}")`,
    );
  }
  return vectors;
}

/**
 * Truncate text inputs to fit a model's hard per-request token limit. We count
 * cl100k tokens (the KB's tokenizer) but the model counts its own, so only a
 * margin-reduced share of the limit is used. Unlike Cohere's server-side
 * `truncate: "END"`, this loses content locally — warn with the count so the
 * degradation is visible.
 */
function truncateTextInputs(params: {
  inputs: EmbeddingInput[];
  model: string;
  maxInputTextTokens?: number;
}): EmbeddingInput[] {
  const { inputs, model, maxInputTextTokens } = params;
  if (maxInputTextTokens === undefined) {
    return inputs;
  }
  const tokenBudget = Math.floor(maxInputTextTokens * TOKEN_LIMIT_MARGIN);
  const encoding = getEncoding();
  let truncatedCount = 0;
  const prepared = inputs.map((input) => {
    if (typeof input !== "string") {
      return input;
    }
    const truncated = truncateToTokens(encoding, input, tokenBudget);
    if (truncated !== input) {
      truncatedCount++;
    }
    return truncated;
  });
  if (truncatedCount > 0) {
    logger.warn(
      { model, truncatedCount, maxInputTextTokens },
      "[BedrockEmbedding] Truncated text inputs over the model's token limit",
    );
  }
  return prepared;
}

/**
 * Reject an image over Cohere's per-image size limit up front — the provider's
 * own error for an oversized payload is an opaque 400, and the base64 size is
 * known before spending the request.
 */
function assertCohereImageSize(
  input: { mimeType: string; data: string },
  model: string,
): void {
  const decodedBytes = Math.floor((input.data.length * 3) / 4);
  if (decodedBytes > COHERE_MAX_IMAGE_BYTES) {
    throw new BedrockEmbeddingError(
      400,
      `Image of ${Math.round(decodedBytes / (1024 * 1024))}MB exceeds the ${Math.round(COHERE_MAX_IMAGE_BYTES / (1024 * 1024))}MB limit of model "${model}"`,
    );
  }
}

function toEmbeddingApiResponse(params: {
  embeddings: number[][];
  tokens: number;
  model: string;
}): EmbeddingApiResponse {
  const { embeddings, tokens, model } = params;
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

function toBedrockEmbeddingError(err: unknown): BedrockEmbeddingError {
  if (err instanceof BedrockEmbeddingError) {
    return err;
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
  return new BedrockEmbeddingError(status, message);
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order.
 * Every item runs to completion (no InvokeModel calls left detached
 * mid-flight), then the first failure in input order is rethrown.
 */
async function mapAllOrThrow<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const settled = await mapWithConcurrency(items, limit, fn);
  return settled.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}

// ===== Internal constants =====

/**
 * Output dimensions assumed accepted on-request for a Bedrock model not in
 * `BEDROCK_EMBEDDING_MODELS` (the Titan v2 set — the historical behavior).
 */
const DEFAULT_ON_REQUEST_DIMENSIONS: readonly number[] = [256, 512, 1024];

/** Bound the per-input fan-out (one InvokeModel call per value). */
const BEDROCK_EMBEDDING_MAX_PARALLEL = 8;

/** Cohere Embed v3 on Bedrock takes at most 96 texts per InvokeModel call. */
const COHERE_MAX_TEXTS_PER_CALL = 96;

/** Cohere's documented per-image limit (base64-decoded size). */
const COHERE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Share of a model's token limit the local cl100k count may fill. The model's
 * own tokenizer segments differently, so aiming at the exact limit would still
 * trip its ValidationException on unlucky inputs.
 */
const TOKEN_LIMIT_MARGIN = 0.85;
