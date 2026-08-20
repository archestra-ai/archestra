import config from "@/config";
import logger from "@/logging";
import { mapWithConcurrency } from "@/utils/concurrency";
import { findCohereEmbeddingModel } from "./cohere-models";
import {
  base64DecodedBytes,
  chunkArray,
  PartialEmbeddingError,
  toEmbeddingApiResponse,
} from "./shared";
import type {
  EmbeddingApiResponse,
  EmbeddingInput,
  EmbeddingPurpose,
} from "./types";

export class CohereEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CohereEmbeddingError";
  }
}

/**
 * A Cohere fan-out where some `/v2/embed` calls succeeded and others failed;
 * every failure reason is normalized to a `CohereEmbeddingError`.
 */
export class CoherePartialEmbeddingError extends PartialEmbeddingError {
  constructor(
    successes: Array<{ index: number; embedding: number[] }>,
    failures: Array<{ index: number; reason: unknown }>,
    tokens: number,
  ) {
    super({
      successes,
      failures,
      tokens,
      toTypedError: toCohereEmbeddingError,
    });
    this.name = "CoherePartialEmbeddingError";
  }
}

/**
 * Embed text and images with Cohere's direct API (`POST /v2/embed`).
 *
 * Two request shapes, dispatched on the configured model via the capability
 * table (`cohere-models.ts`):
 *   - Embed v4 takes mixed `inputs[]` — text and images interleaved in one
 *     call (≤96 inputs, ≤20MB of images per call), and an on-request
 *     `output_dimension`.
 *   - Embed v3 takes `texts[]` (≤96 per call, server-side token truncation)
 *     and exactly ONE image per call under `input_type: "image"`.
 * Results are reassembled in input order. An unknown model takes the v3 text
 * path and rejects images with a typed 400, like the other clients.
 *
 * Like every other embedding client, this attempts the embed and surfaces the
 * provider's own error — it does not pre-screen whether the account has
 * access to the model.
 */
export async function callCohereEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
  purpose?: EmbeddingPurpose;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions, purpose } = params;
  const entry = findCohereEmbeddingModel(model);
  const url = buildEmbedUrl(baseUrl);
  const inputType = purpose ?? "search_document";

  // Reject oversized images up front — Cohere's own error for an oversized
  // payload is an opaque 400, and the size is known before spending a request.
  for (const input of inputs) {
    if (typeof input !== "string") {
      if (!entry?.inputModalities.includes("image")) {
        throw new CohereEmbeddingError(
          400,
          `Model "${model}" doesn't support embedding image inputs. Use a multimodal Cohere embedding model (e.g. embed-v4.0) to embed images.`,
        );
      }
      assertImageSize(input, model);
    }
  }

  const embeddings = new Array<number[]>(inputs.length);
  let tokens = 0;
  let billedImages = 0;
  const calls: EmbedCall[] = [];
  const request = async (
    body: Record<string, unknown>,
  ): Promise<number[][]> => {
    const response = await postEmbed({ url, apiKey, body, model });
    tokens += response.meta?.billed_units?.input_tokens ?? 0;
    billedImages += response.meta?.billed_units?.images ?? 0;
    return response.vectors;
  };

  const outputDimension =
    dimensions !== undefined && entry?.onRequestDimensions?.includes(dimensions)
      ? { output_dimension: dimensions }
      : {};

  if (entry?.requestShape === "inputs") {
    // v4: every input is one `inputs[]` item, batched in order.
    for (const batch of batchMixedInputs(inputs)) {
      calls.push({
        indices: batch.map((item) => item.index),
        run: async () => {
          const vectors = await request({
            model,
            inputs: batch.map((item) => toV4Input(item.input)),
            input_type: inputType,
            embedding_types: ["float"],
            ...outputDimension,
          });
          assertVectorCount(vectors, batch.length, model);
          batch.forEach((item, i) => {
            embeddings[item.index] = vectors[i];
          });
        },
      });
    }
  } else {
    // v3 (and unknown models): texts batched, one image per call.
    const textEntries: Array<{ index: number; text: string }> = [];
    const imageEntries: Array<{ index: number; dataUri: string }> = [];
    inputs.forEach((input, index) => {
      if (typeof input === "string") {
        textEntries.push({ index, text: input });
      } else {
        imageEntries.push({ index, dataUri: toDataUri(input) });
      }
    });
    for (const batch of chunkArray(textEntries, COHERE_MAX_INPUTS_PER_CALL)) {
      calls.push({
        indices: batch.map((item) => item.index),
        run: async () => {
          const vectors = await request({
            model,
            texts: batch.map((item) => item.text),
            input_type: inputType,
            embedding_types: ["float"],
            // Cohere embeds at most 512 tokens per text on v3; "END" degrades an
            // over-long chunk to a truncated vector instead of failing the call.
            truncate: "END",
            ...outputDimension,
          });
          assertVectorCount(vectors, batch.length, model);
          batch.forEach((item, i) => {
            embeddings[item.index] = vectors[i];
          });
        },
      });
    }
    for (const image of imageEntries) {
      calls.push({
        indices: [image.index],
        run: async () => {
          const vectors = await request({
            model,
            images: [image.dataUri],
            input_type: "image",
            embedding_types: ["float"],
            ...outputDimension,
          });
          assertVectorCount(vectors, 1, model);
          embeddings[image.index] = vectors[0];
        },
      });
    }
  }

  const settled = await mapWithConcurrency(
    calls,
    COHERE_EMBEDDING_MAX_PARALLEL,
    (call) => call.run(),
  );
  const failures = settled.flatMap((result, callIndex) =>
    result.status === "rejected"
      ? calls[callIndex].indices.map((index) => ({
          index,
          reason: result.reason,
        }))
      : [],
  );
  if (failures.length > 0) {
    const failedIndices = new Set(failures.map((failure) => failure.index));
    const successes = embeddings.flatMap((embedding, index) =>
      embedding && !failedIndices.has(index) ? [{ index, embedding }] : [],
    );
    // Nothing succeeded: surface the first failure itself — a "partial" error
    // is reserved for fan-outs with vectors worth banking.
    if (successes.length === 0) {
      throw toCohereEmbeddingError(
        failures.sort((a, b) => a.index - b.index)[0].reason,
      );
    }
    throw new CoherePartialEmbeddingError(successes, failures, tokens);
  }

  if (billedImages > 0) {
    logger.debug(
      { model, billedImages },
      "[CohereEmbedding] Embedded image inputs",
    );
  }

  return toEmbeddingApiResponse({ embeddings, tokens, model });
}

// ===== Internal helpers =====

interface EmbedCall {
  indices: number[];
  run: () => Promise<void>;
}

/**
 * The configured Cohere base URL may carry a version segment; the v2 embed
 * route lives at /v2/embed on the API root (same normalization as the native
 * rerank client).
 */
function buildEmbedUrl(baseUrl: string | null | undefined): string {
  const base = (baseUrl || config.llm.cohere.baseUrl)
    .replace(/\/+$/, "")
    .replace(/\/v[12]$/, "");
  return `${base}/v2/embed`;
}

/**
 * Batch v4 inputs in order: at most 96 per call, and the images in one call
 * must stay under Cohere's combined-size cap. The base64 payload length is
 * used as the size (the conservative side of "combined size of all images").
 */
function batchMixedInputs(
  inputs: EmbeddingInput[],
): Array<Array<{ index: number; input: EmbeddingInput }>> {
  const batches: Array<Array<{ index: number; input: EmbeddingInput }>> = [];
  let current: Array<{ index: number; input: EmbeddingInput }> = [];
  let currentImageBytes = 0;
  inputs.forEach((input, index) => {
    const imageBytes = typeof input === "string" ? 0 : input.data.length;
    const overflows =
      current.length >= COHERE_MAX_INPUTS_PER_CALL ||
      (current.length > 0 &&
        currentImageBytes + imageBytes > COHERE_MAX_IMAGE_BYTES_PER_CALL);
    if (overflows) {
      batches.push(current);
      current = [];
      currentImageBytes = 0;
    }
    current.push({ index, input });
    currentImageBytes += imageBytes;
  });
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function toV4Input(input: EmbeddingInput): {
  content: Array<Record<string, unknown>>;
} {
  return typeof input === "string"
    ? { content: [{ type: "text", text: input }] }
    : {
        content: [{ type: "image_url", image_url: { url: toDataUri(input) } }],
      };
}

function toDataUri(input: { mimeType: string; data: string }): string {
  return `data:${input.mimeType};base64,${input.data}`;
}

function assertImageSize(
  input: { mimeType: string; data: string },
  model: string,
): void {
  const decodedBytes = base64DecodedBytes(input.data);
  if (decodedBytes > COHERE_MAX_IMAGE_BYTES) {
    throw new CohereEmbeddingError(
      400,
      `Image of ${Math.round(decodedBytes / (1024 * 1024))}MB exceeds the ${Math.round(COHERE_MAX_IMAGE_BYTES / (1024 * 1024))}MB limit of model "${model}"`,
    );
  }
}

function assertVectorCount(
  vectors: number[][],
  expectedCount: number,
  model: string,
): void {
  if (vectors.length !== expectedCount) {
    throw new CohereEmbeddingError(
      500,
      `Cohere returned ${vectors.length} embedding(s) for ${expectedCount} input(s) (model "${model}")`,
    );
  }
}

/**
 * Cohere's embeddings arrive keyed by embedding type (`{float: [...]}`) when
 * `embedding_types` is sent, or as a bare array of vectors otherwise — parse
 * both defensively. Usage is reported under `meta.billed_units`.
 */
interface CohereEmbedResponseBody {
  embeddings?: number[][] | { float?: number[][] };
  meta?: { billed_units?: { input_tokens?: number; images?: number } };
  message?: string;
}

async function postEmbed(params: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  model: string;
}): Promise<{
  vectors: number[][];
  meta?: CohereEmbedResponseBody["meta"];
}> {
  const { url, apiKey, body, model } = params;
  // A network-level failure (refused connection, DNS) propagates as-is so
  // retry classification can see its errno.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: CohereEmbedResponseBody = {};
  try {
    parsed = text ? (JSON.parse(text) as CohereEmbedResponseBody) : {};
  } catch {
    // A non-JSON body is handled below as an error/empty response.
  }

  if (!response.ok) {
    throw new CohereEmbeddingError(
      response.status,
      parsed.message ||
        `Cohere embed request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }

  const raw = parsed.embeddings;
  const vectors = Array.isArray(raw) ? raw : raw?.float;
  if (!Array.isArray(vectors)) {
    throw new CohereEmbeddingError(
      500,
      `Cohere returned no embeddings array (model "${model}")`,
    );
  }
  return { vectors, meta: parsed.meta };
}

function toCohereEmbeddingError(err: unknown): CohereEmbeddingError {
  if (err instanceof CohereEmbeddingError) {
    return err;
  }
  const status =
    (err as { statusCode?: number; status?: number }).statusCode ??
    (err as { statusCode?: number; status?: number }).status ??
    500;
  const message = err instanceof Error ? err.message : String(err);
  return new CohereEmbeddingError(status, message);
}

// ===== Internal constants =====

/** Bound the per-call fan-out against Cohere's per-minute input limits. */
const COHERE_EMBEDDING_MAX_PARALLEL = 4;

/** Cohere takes at most 96 texts / inputs per `/v2/embed` call. */
const COHERE_MAX_INPUTS_PER_CALL = 96;

/** Cohere's documented per-image limit (base64-decoded size). */
const COHERE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Embed v4: the combined size of all images in one request, at most 20MB. */
const COHERE_MAX_IMAGE_BYTES_PER_CALL = 20 * 1024 * 1024;
