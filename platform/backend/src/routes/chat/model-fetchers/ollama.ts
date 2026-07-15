import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import type { ModelDefaultParameters } from "@/types/model";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import {
  type FetchedModelCapabilities,
  type ModelInfo,
  PLACEHOLDER_API_KEY,
} from "./types";

const OllamaModelsListSchema = z.object({
  data: z.array(z.object({ id: z.string(), created: z.number().optional() })),
});

const OllamaShowResponseSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  parameters: z.string().optional(),
});

type OllamaShowResponse = z.infer<typeof OllamaShowResponseSchema>;

// `/api/show` is metadata-only, but bound the fan-out and time-box each request
// so a large catalog can't burst and one hung server can't hold the sync open.
const SHOW_CONCURRENCY = 8;
const SHOW_TIMEOUT_MS = 5_000;

/**
 * Ollama model fetcher. Lists models via the OpenAI-compatible `/v1/models`
 * endpoint, then enriches each with Ollama's native `POST /api/show` so
 * embedding models are detected authoritatively (rather than by name) and their
 * context length / default parameters are pulled through. `/api/show` failures
 * degrade gracefully per model: the model is still returned, just without
 * capabilities, so the downstream name heuristic applies.
 */
export async function fetchOllamaModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.ollama.baseUrl;
  const token = apiKey || PLACEHOLDER_API_KEY;

  const { data } = await fetchModelsWithBearerAuth({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey: token,
    errorLabel: "Ollama models",
    extraHeaders,
    schema: OllamaModelsListSchema,
  });

  // `/api/show` lives at the Ollama root, not under the OpenAI-compat `/v1`.
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const showUrl = joinBaseUrl(root, "/api/show");

  const shows = await fetchShowsBounded(data, showUrl, token, extraHeaders);

  return data.map((model, index) => {
    const show = shows[index];
    const capabilities = show ? toFetchedCapabilities(show) : undefined;
    return {
      id: model.id,
      displayName: model.id,
      provider: "ollama",
      createdAt: model.created
        ? new Date(model.created * 1000).toISOString()
        : undefined,
      capabilities,
    };
  });
}

/**
 * Enrich each model via `/api/show` with a bounded worker pool. `fetchOllamaShow`
 * never throws (failures degrade to null), so the result array aligns with
 * `models` by index. The shared `cursor` increment is atomic (no await between
 * read and increment), so no two workers claim the same index.
 */
async function fetchShowsBounded(
  models: Array<{ id: string }>,
  url: string,
  token: string,
  extraHeaders?: Record<string, string> | null,
): Promise<Array<OllamaShowResponse | null>> {
  const results: Array<OllamaShowResponse | null> = new Array(
    models.length,
  ).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < models.length) {
      const index = cursor++;
      results[index] = await fetchOllamaShow({
        url,
        model: models[index].id,
        token,
        extraHeaders,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SHOW_CONCURRENCY, models.length) }, worker),
  );
  return results;
}

async function fetchOllamaShow(params: {
  url: string;
  model: string;
  token: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<OllamaShowResponse | null> {
  const { url, model, token, extraHeaders } = params;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...(extraHeaders ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.debug(
        { model, status: response.status },
        "Ollama /api/show returned non-2xx; falling back to name heuristic",
      );
      return null;
    }
    return OllamaShowResponseSchema.parse(await response.json());
  } catch (error) {
    logger.debug(
      { model, err: error instanceof Error ? error.message : String(error) },
      "Ollama /api/show failed; falling back to name heuristic",
    );
    return null;
  }
}

function toFetchedCapabilities(
  show: OllamaShowResponse,
): FetchedModelCapabilities {
  const contextLength =
    readModelInfoNumber(show.model_info, ".context_length") ?? null;
  const defaultParameters = parseOllamaParameters(show.parameters);

  // `capabilities` distinguishes embedding models from generative ones. Tri-state:
  // - embedding model with a reported dimension -> the number (authoritative).
  // - embedding model with no reported dimension -> undefined, so the name
  //   heuristic can still rescue a known dimension.
  // - authoritatively generative -> null (not an embedding model; skip heuristic).
  // - no capabilities array (older Ollama) -> undefined (name heuristic decides).
  let embeddingDimensions: number | null | undefined;
  if (show.capabilities) {
    embeddingDimensions = show.capabilities.includes("embedding")
      ? readModelInfoNumber(show.model_info, ".embedding_length")
      : null;
  }

  return { contextLength, embeddingDimensions, defaultParameters };
}

function readModelInfoNumber(
  modelInfo: Record<string, unknown> | undefined,
  suffix: string,
): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(suffix) && typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

/**
 * Parse Ollama's `parameters` block (newline-delimited `key<whitespace>value`
 * lines) into a structured map. Repeated keys (e.g. `stop`) collect into an
 * array. Numeric coercion applies only to unquoted values, so a quoted stop
 * token like `"128"` stays a string.
 */
function parseOllamaParameters(
  raw: string | undefined,
): ModelDefaultParameters | null {
  if (!raw) return null;
  const collected = new Map<string, (string | number)[]>();
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = coerceParamValue(rawValue.trim());
    const existing = collected.get(key);
    if (existing) {
      existing.push(value);
    } else {
      collected.set(key, [value]);
    }
  }
  if (collected.size === 0) return null;
  const result: ModelDefaultParameters = {};
  for (const [key, values] of collected) {
    result[key] = values.length === 1 ? values[0] : values.map(String);
  }
  return result;
}

function coerceParamValue(raw: string): string | number {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  const num = Number(raw);
  return raw !== "" && !Number.isNaN(num) ? num : raw;
}
