import { GoogleAuth } from "google-auth-library";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import config from "@/config";
import logger from "@/logging";
import { mapWithConcurrency } from "@/utils/concurrency";
import {
  base64DecodedBytes,
  collectPartialEmbeddingResults,
  PartialEmbeddingError,
  toEmbeddingApiResponse,
} from "./shared";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";
import { findVertexMultimodalEmbeddingModel } from "./vertex-models";

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
 * A Vertex `:predict` fan-out where some inputs embedded and others failed;
 * every failure reason is normalized to a `GeminiEmbeddingError`.
 */
export class GeminiPartialEmbeddingError extends PartialEmbeddingError {
  constructor(
    successes: Array<{ index: number; embedding: number[] }>,
    failures: Array<{ index: number; reason: unknown }>,
  ) {
    super({
      successes,
      failures,
      tokens: 0,
      toTypedError: toGeminiEmbeddingError,
    });
    this.name = "GeminiPartialEmbeddingError";
  }
}

/**
 * Embed multiple inputs using the Google GenAI SDK's `embedContent` method.
 * Supports both text strings and inline images (multimodal), as well as
 * API key mode and Vertex AI mode (via `createGoogleGenAIClient`).
 *
 * Vertex AI's pre-Gemini publisher embedding models (`multimodalembedding@001`,
 * see `vertex-models.ts`) do not speak `embedContent` — they are served only by
 * the Vertex `:predict` endpoint with a per-modality instance shape — so they
 * dispatch to a direct predict call instead (`embedViaVertexPredict`).
 *
 * TODO: Add support for audio and video modalities — gemini-embedding-2
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

  const vertexEntry = findVertexMultimodalEmbeddingModel(model);
  if (vertexEntry) {
    return embedViaVertexPredict({ inputs, model, dimensions });
  }

  const modelId = getGeminiEmbeddingModelId(model);

  const client = createGoogleGenAIClient(
    apiKey,
    "[GeminiEmbedding]",
    baseUrl,
    modelId,
  );

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
    throw toGeminiEmbeddingError(err);
  }
}

// ===== Internal helpers =====

/**
 * Embed inputs with a Vertex AI publisher embedding model over raw
 * `:predict` calls — one instance per request, which is all
 * `multimodalembedding@001` accepts. Text instances are `{text}`; image
 * instances are `{image: {bytesBase64Encoded}}`. The API rejects text over
 * 1024 UTF-8 bytes before the documented 32-token model-side shortening, so
 * text is clamped to its payload cap first.
 *
 * Auth uses the same ADC / service-account resolution as the GenAI SDK's
 * Vertex mode (`config.llm.gemini.vertexAi`), via google-auth-library; the
 * model exists only on Vertex, so API-key mode is rejected up front with a
 * typed 400 rather than the GenAI client's API-key error.
 */
async function embedViaVertexPredict(params: {
  inputs: EmbeddingInput[];
  model: string;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, dimensions } = params;
  const entry = findVertexMultimodalEmbeddingModel(model);
  if (!entry) {
    throw new GeminiEmbeddingError(
      400,
      `Model "${model}" is not a supported Vertex multimodal embedding model`,
    );
  }
  if (!isVertexAiEnabled()) {
    throw new GeminiEmbeddingError(
      400,
      `Model "${model}" is served by Vertex AI only. Enable Vertex AI mode (ARCHESTRA_GEMINI_VERTEX_AI_ENABLED) to embed with it.`,
    );
  }

  const { location, project } = config.llm.gemini.vertexAi;
  const endpoint = buildVertexPredictUrl({
    project,
    location,
    modelId: entry.modelId,
  });
  const dimension =
    dimensions !== undefined && entry.onRequestDimensions.includes(dimensions)
      ? dimensions
      : undefined;

  let truncatedCount = 0;
  const preparedInputs = inputs.map((input) => {
    if (typeof input === "string") {
      const text = truncateToUtf8Bytes(input, entry.maxInputTextBytes);
      if (text !== input) {
        truncatedCount++;
      }
      return text;
    }
    assertVertexImageSize(input, entry.modelId, entry.maxImageBytes);
    return input;
  });
  if (truncatedCount > 0) {
    logger.warn(
      {
        model: entry.modelId,
        truncatedCount,
        maxInputTextBytes: entry.maxInputTextBytes,
      },
      "[GeminiEmbedding] Truncated Vertex text inputs over the model's byte cap",
    );
  }

  const auth = VertexAiAuthClient.getInstance();
  const settled = await mapWithConcurrency(
    preparedInputs,
    VERTEX_EMBEDDING_MAX_PARALLEL,
    async (input) => {
      const body: Record<string, unknown> = {
        instances: [
          typeof input === "string"
            ? { text: input }
            : { image: { bytesBase64Encoded: input.data } },
        ],
        ...(dimension !== undefined ? { parameters: { dimension } } : {}),
      };
      const prediction = await postVertexPredict({
        endpoint,
        accessToken: await auth.getAccessToken(),
        body,
        model: entry.modelId,
      });
      const embedding =
        typeof input === "string"
          ? prediction.textEmbedding
          : prediction.imageEmbedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new GeminiEmbeddingError(
          500,
          `Vertex AI predict response did not include an embedding for the ${typeof input === "string" ? "text" : "image"} input (model "${entry.modelId}")`,
        );
      }
      return embedding;
    },
  );

  const { successes, failures } = collectPartialEmbeddingResults(settled);
  if (failures.length > 0) {
    // Nothing succeeded: surface the first failure itself — a "partial" error
    // is reserved for fan-outs with vectors worth banking.
    if (successes.length === 0) {
      throw toGeminiEmbeddingError(
        failures.sort((a, b) => a.index - b.index)[0].reason,
      );
    }
    throw new GeminiPartialEmbeddingError(successes, failures);
  }

  const embeddings = successes
    .sort((a, b) => a.index - b.index)
    .map((success) => success.embedding);
  return toEmbeddingApiResponse({ embeddings, tokens: 0, model });
}

/**
 * Lazily-created process-wide Google auth client for Vertex predict calls.
 * google-auth-library caches and refreshes access tokens internally, so one
 * instance serves every embed call; the credential source (service-account
 * key file or ADC) mirrors `createGoogleGenAIClient`.
 */
class VertexAiAuthClient {
  private static instance: VertexAiAuthClient | null = null;
  private readonly auth: GoogleAuth;

  static getInstance(): VertexAiAuthClient {
    if (!VertexAiAuthClient.instance) {
      VertexAiAuthClient.instance = new VertexAiAuthClient();
    }
    return VertexAiAuthClient.instance;
  }

  private constructor() {
    const { vertexAi } = config.llm.gemini;
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      projectId: vertexAi.project || undefined,
      ...(vertexAi.credentialsFile && {
        keyFilename: vertexAi.credentialsFile,
      }),
    });
  }

  async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) {
      throw new GeminiEmbeddingError(
        401,
        "Vertex AI authentication returned no access token — check ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE or the ADC setup",
      );
    }
    return token.token;
  }
}

/**
 * The regional predict endpoint for a publisher model. The `global` location
 * (Vertex's default for some Gemini models) has no location prefix on the host.
 */
function buildVertexPredictUrl(params: {
  project: string;
  location: string;
  modelId: string;
}): string {
  const { project, location, modelId } = params;
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:predict`;
}

interface VertexPredictPrediction {
  textEmbedding?: number[];
  imageEmbedding?: number[];
}

async function postVertexPredict(params: {
  endpoint: string;
  accessToken: string;
  body: Record<string, unknown>;
  model: string;
}): Promise<VertexPredictPrediction> {
  const { endpoint, accessToken, body, model } = params;
  // A network-level failure (refused connection, DNS) propagates as-is so
  // retry classification can see its errno.
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: {
    predictions?: VertexPredictPrediction[];
    error?: { message?: string };
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON body is handled below as an error/empty response.
  }

  if (!response.ok) {
    throw new GeminiEmbeddingError(
      response.status,
      parsed.error?.message ||
        `Vertex AI predict request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }

  const prediction = parsed.predictions?.[0];
  if (!prediction) {
    throw new GeminiEmbeddingError(
      500,
      `Vertex AI predict returned no predictions (model "${model}")`,
    );
  }
  return prediction;
}

function assertVertexImageSize(
  input: { mimeType: string; data: string },
  model: string,
  maxImageBytes: number,
): void {
  const decodedBytes = base64DecodedBytes(input.data);
  if (decodedBytes > maxImageBytes) {
    throw new GeminiEmbeddingError(
      400,
      `Image of ${Math.round(decodedBytes / (1024 * 1024))}MB exceeds the ${Math.round(maxImageBytes / (1024 * 1024))}MB limit of model "${model}"`,
    );
  }
}

/** Truncate at a Unicode code-point boundary without exceeding UTF-8 bytes. */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  const chars: string[] = [];
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    chars.push(char);
    bytes += charBytes;
  }
  return chars.join("");
}

function toGeminiEmbeddingError(err: unknown): GeminiEmbeddingError {
  if (err instanceof GeminiEmbeddingError) {
    return err;
  }
  const status =
    (err as { status?: number; httpStatusCode?: number }).status ??
    (err as { status?: number; httpStatusCode?: number }).httpStatusCode ??
    500;
  const message =
    (err as { message?: string }).message ??
    (err instanceof Error ? err.message : String(err));
  return new GeminiEmbeddingError(status, message);
}

function getGeminiEmbeddingModelId(model: string): string {
  if (isVertexAiEnabled()) {
    return model.replace(/^models\//, "");
  }

  return model.startsWith("models/") ? model : `models/${model}`;
}

// ===== Internal constants =====

/**
 * Bound the per-input predict fan-out: `multimodalembedding@001` is quotaed
 * at 120-600 requests per minute per project (region-dependent), far below
 * the Gemini embedding family's limits.
 */
const VERTEX_EMBEDDING_MAX_PARALLEL = 4;
