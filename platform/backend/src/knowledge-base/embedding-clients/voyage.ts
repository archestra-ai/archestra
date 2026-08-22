import config from "@/config";
import logger from "@/logging";
import { mapWithConcurrency } from "@/utils/concurrency";
import { countTokens, getEncoding } from "../tokenizer";
import {
  base64DecodedBytes,
  PartialEmbeddingError,
  toEmbeddingApiResponse,
  truncateTextInputsToTokens,
} from "./shared";
import type {
  EmbeddingApiResponse,
  EmbeddingInput,
  EmbeddingPurpose,
} from "./types";
import { findVoyageEmbeddingModel } from "./voyage-models";

export class VoyageEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VoyageEmbeddingError";
  }
}

/**
 * A Voyage fan-out where some calls succeeded and others failed; every failure
 * reason is normalized to a `VoyageEmbeddingError`.
 */
export class VoyagePartialEmbeddingError extends PartialEmbeddingError {
  constructor(
    successes: Array<{ index: number; embedding: number[] }>,
    failures: Array<{ index: number; reason: unknown }>,
    tokens: number,
  ) {
    super({
      successes,
      failures,
      tokens,
      toTypedError: toVoyageEmbeddingError,
    });
    this.name = "VoyagePartialEmbeddingError";
  }
}

/**
 * Embed text and images with Voyage AI.
 *
 * Voyage is an embeddings-ONLY provider (it publishes no chat API), served over
 * two endpoints that are not interchangeable — the model decides which, via the
 * capability table (`voyage-models.ts`):
 *   - `POST /v1/embeddings` takes `input[]` of plain strings. The text-only
 *     models live here and reject the multimodal model names.
 *   - `POST /v1/multimodalembeddings` takes `inputs[].content[]` with text and
 *     images interleaved, and serves ONLY the multimodal models — their text
 *     goes here too, not through `/embeddings`.
 *
 * Batches are packed against the model's per-request TOKEN budget rather than a
 * flat input count: Voyage caps the sum of all tokens in a request (120K-1M
 * depending on the model), separately from the per-input context limit, and
 * exceeding it fails the whole batch with a 400.
 *
 * Like every other embedding client, this attempts the embed and surfaces the
 * provider's own error — it does not pre-screen whether the account has access
 * to the model.
 */
export async function callVoyageEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
  purpose?: EmbeddingPurpose;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions, purpose } = params;
  const entry = findVoyageEmbeddingModel(model);
  const isMultimodal = entry?.endpoint === "multimodalembeddings";

  // An unknown model takes the text path and rejects images, like the other
  // clients — a mis-tagged row can never make us send an image to a model with
  // no image support.
  for (const input of inputs) {
    if (typeof input !== "string") {
      if (!entry?.inputModalities.includes("image")) {
        throw new VoyageEmbeddingError(
          400,
          `Model "${model}" doesn't support embedding image inputs. Use a multimodal Voyage embedding model (e.g. voyage-multimodal-3.5) to embed images.`,
        );
      }
      assertImageSize(input, model);
    }
  }

  // Voyage's `truncation: true` handles the per-input context limit server-side,
  // but an over-long input still counts its FULL length against the per-request
  // token budget, so trim locally first to keep batch packing honest.
  const prepared = truncateTextInputsToTokens({
    inputs,
    model,
    maxInputTextTokens: entry?.contextTokens,
    logPrefix: "[VoyageEmbedding]",
  });

  const url = buildEmbedUrl(baseUrl, entry?.endpoint ?? "embeddings");
  const outputDimension =
    dimensions !== undefined &&
    entry?.onRequestDimensions?.includes(
      dimensions as (typeof entry.onRequestDimensions)[number],
    )
      ? { output_dimension: dimensions }
      : {};

  const embeddings = new Array<number[]>(prepared.length);
  let tokens = 0;
  const batches = packBatches(
    prepared,
    entry?.maxRequestTokens ?? VOYAGE_FALLBACK_REQUEST_TOKENS,
  );
  const calls: EmbedCall[] = batches.map((batch) => ({
    indices: batch.map((item) => item.index),
    run: async () => {
      const body = isMultimodal
        ? {
            model,
            inputs: batch.map((item) => ({
              content: [toMultimodalContent(item.input)],
            })),
            input_type: toInputType(purpose),
            truncation: true,
            ...outputDimension,
          }
        : {
            model,
            // The text endpoint only reaches here for text-only models, whose
            // image inputs were already rejected above.
            input: batch.map((item) => String(item.input)),
            input_type: toInputType(purpose),
            truncation: true,
            output_dtype: "float",
            ...outputDimension,
          };
      const response = await postEmbed({ url, apiKey, body, model });
      tokens += response.usage?.total_tokens ?? 0;
      placeVectors({ response, batch, embeddings, model });
    },
  }));

  const settled = await mapWithConcurrency(
    calls,
    VOYAGE_EMBEDDING_MAX_PARALLEL,
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
      throw toVoyageEmbeddingError(
        failures.sort((a, b) => a.index - b.index)[0].reason,
      );
    }
    throw new VoyagePartialEmbeddingError(successes, failures, tokens);
  }

  return toEmbeddingApiResponse({ embeddings, tokens, model });
}

// ===== Internal helpers =====

interface EmbedCall {
  indices: number[];
  run: () => Promise<void>;
}

interface BatchItem {
  index: number;
  input: EmbeddingInput;
}

/**
 * Voyage's `input_type` is `"query"`/`"document"` — its own spelling, not the
 * `search_query`/`search_document` that Cohere uses. The API prepends a
 * prompt to the input for either value, so a query embedded as a document (or
 * vice versa) silently lands in a different part of the space and degrades
 * ranking.
 */
function toInputType(purpose: EmbeddingPurpose | undefined): string {
  return purpose === "search_query" ? "query" : "document";
}

/**
 * The configured Voyage base URL may or may not carry the `/v1` segment;
 * normalize so both endpoints are addressed off the API root exactly once.
 */
function buildEmbedUrl(
  baseUrl: string | null | undefined,
  endpoint: "embeddings" | "multimodalembeddings",
): string {
  const base = (baseUrl || config.llm.voyage.baseUrl)
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  return `${base}/v1/${endpoint}`;
}

/**
 * Pack inputs into batches that respect BOTH Voyage's per-request input count
 * and its per-request total-token budget, preserving input order.
 *
 * Text is measured with the KB's own cl100k tokenizer against a margin-reduced
 * budget — Voyage counts with its own tokenizer, so aiming at the exact limit
 * would still trip its validation on unlucky inputs. Images are charged the
 * documented worst case (16M pixels ÷ 560 pixels-per-token) because their real
 * cost needs the decoded pixel count; over-charging can only produce smaller,
 * safer batches, whereas guessing low would risk a 400 that fails every input
 * in the batch.
 */
function packBatches(
  inputs: EmbeddingInput[],
  maxRequestTokens: number,
): BatchItem[][] {
  const budget = Math.floor(maxRequestTokens * VOYAGE_TOKEN_BUDGET_MARGIN);
  const encoding = getEncoding();
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let currentTokens = 0;

  inputs.forEach((input, index) => {
    const cost =
      typeof input === "string"
        ? countTokens(encoding, input)
        : VOYAGE_IMAGE_TOKEN_WORST_CASE;
    const overflows =
      current.length >= VOYAGE_MAX_INPUTS_PER_CALL ||
      // Keep a single over-budget input in a batch of its own rather than
      // dropping it: Voyage's server-side truncation is its last line of
      // defense, and a lone input is the smallest request we can make.
      (current.length > 0 && currentTokens + cost > budget);
    if (overflows) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push({ index, input });
    currentTokens += cost;
  });
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function toMultimodalContent(input: EmbeddingInput): Record<string, unknown> {
  return typeof input === "string"
    ? { type: "text", text: input }
    : {
        // Voyage takes the image as a data URL under `image_base64`, not as a
        // bare base64 payload.
        type: "image_base64",
        image_base64: `data:${input.mimeType};base64,${input.data}`,
      };
}

function assertImageSize(
  input: { mimeType: string; data: string },
  model: string,
): void {
  const decodedBytes = base64DecodedBytes(input.data);
  if (decodedBytes > VOYAGE_MAX_IMAGE_BYTES) {
    throw new VoyageEmbeddingError(
      400,
      `Image of ${Math.round(decodedBytes / (1024 * 1024))}MB exceeds the ${Math.round(VOYAGE_MAX_IMAGE_BYTES / (1024 * 1024))}MB limit of model "${model}"`,
    );
  }
}

/**
 * Place a response's vectors back at their original input positions. Voyage
 * returns each embedding with the `index` it had IN THE REQUEST, so the batch's
 * own mapping is applied rather than trusting array order.
 */
function placeVectors(params: {
  response: VoyageEmbedResponseBody;
  batch: BatchItem[];
  embeddings: number[][];
  model: string;
}): void {
  const { response, batch, embeddings, model } = params;
  const data = response.data;
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new VoyageEmbeddingError(
      500,
      `Voyage returned ${Array.isArray(data) ? data.length : 0} embedding(s) for ${batch.length} input(s) (model "${model}")`,
    );
  }
  data.forEach((item, position) => {
    // `index` is authoritative when present; fall back to array order for a
    // response that omits it.
    const batchPosition =
      typeof item.index === "number" ? item.index : position;
    const target = batch[batchPosition];
    if (!target || !Array.isArray(item.embedding)) {
      throw new VoyageEmbeddingError(
        500,
        `Voyage returned an embedding at unexpected index ${batchPosition} (model "${model}")`,
      );
    }
    embeddings[target.index] = item.embedding;
  });
}

/**
 * Voyage's response is OpenAI-shaped, but its usage block reports only
 * `total_tokens` (plus pixel counts on the multimodal endpoint) — there is no
 * `prompt_tokens`. Errors arrive as `detail`.
 */
interface VoyageEmbedResponseBody {
  data?: Array<{ object?: string; embedding?: number[]; index?: number }>;
  model?: string;
  usage?: {
    total_tokens?: number;
    text_tokens?: number;
    image_pixels?: number;
  };
  detail?: string;
  message?: string;
  error?: string | { message?: string };
}

async function postEmbed(params: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  model: string;
}): Promise<VoyageEmbedResponseBody> {
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
  let parsed: VoyageEmbedResponseBody = {};
  try {
    parsed = text ? (JSON.parse(text) as VoyageEmbedResponseBody) : {};
  } catch {
    // A non-JSON body is handled below as an error/empty response.
  }

  if (!response.ok) {
    throw new VoyageEmbeddingError(
      response.status,
      describeErrorBody(parsed) ||
        `Voyage embed request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }

  if (!Array.isArray(parsed.data)) {
    throw new VoyageEmbeddingError(
      500,
      `Voyage returned no embeddings array (model "${model}")`,
    );
  }
  if (parsed.usage?.image_pixels) {
    logger.debug(
      { model, imagePixels: parsed.usage.image_pixels },
      "[VoyageEmbedding] Embedded image inputs",
    );
  }
  return parsed;
}

function describeErrorBody(body: VoyageEmbedResponseBody): string | undefined {
  if (typeof body.error === "string") {
    return body.error;
  }
  return body.detail || body.message || body.error?.message;
}

function toVoyageEmbeddingError(err: unknown): VoyageEmbeddingError {
  if (err instanceof VoyageEmbeddingError) {
    return err;
  }
  const status =
    (err as { statusCode?: number; status?: number }).statusCode ??
    (err as { statusCode?: number; status?: number }).status ??
    500;
  const message = err instanceof Error ? err.message : String(err);
  return new VoyageEmbeddingError(status, message);
}

// ===== Internal constants =====

/** Bound the per-call fan-out against Voyage's per-minute request limits. */
const VOYAGE_EMBEDDING_MAX_PARALLEL = 4;

/** Voyage takes at most 1000 inputs per request, on both endpoints. */
const VOYAGE_MAX_INPUTS_PER_CALL = 1000;

/** Voyage's documented per-image limit (base64-decoded size). */
const VOYAGE_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Worst-case token cost of one image: the documented 16M-pixel ceiling at
 * Voyage's 560-pixels-per-token rate. See `packBatches` for why the worst case
 * is the safe estimate.
 */
const VOYAGE_IMAGE_TOKEN_WORST_CASE = Math.ceil(16_000_000 / 560);

/**
 * Share of a model's per-request token budget the local cl100k count may fill.
 * Voyage segments differently, so aiming at the exact limit would still trip
 * its validation on unlucky inputs.
 */
const VOYAGE_TOKEN_BUDGET_MARGIN = 0.85;

/**
 * Budget used for a model that is not in the capability table — the smallest
 * documented Voyage per-request limit, so an unknown model can only ever be
 * batched more conservatively than a known one.
 */
const VOYAGE_FALLBACK_REQUEST_TOKENS = 120_000;
