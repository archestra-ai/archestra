import { isUsableGeminiCatalogModel } from "@archestra/shared";
import { createGoogleGenAIClient } from "@/clients/gemini-client";
import config from "@/config";
import logger from "@/logging";
import type { Gemini } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";

export async function fetchGeminiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.gemini.baseUrl;
  const url = joinBaseUrl(
    baseUrl,
    `/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
  );

  const response = await fetch(url, {
    headers: extraHeaders ?? undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Gemini models",
    );
    throw new Error(`Failed to fetch Gemini models: ${response.status}`);
  }

  const data = (await response.json()) as {
    models: Gemini.Types.Model[];
  };

  return data.models
    .filter(
      (model) =>
        model.supportedGenerationMethods?.includes("generateContent") ||
        model.supportedGenerationMethods?.includes("embedContent") ||
        model.supportedGenerationMethods?.includes("batchEmbedContents") ||
        false,
    )
    .map((model) => {
      const modelId = model.name.replace("models/", "");
      return {
        id: modelId,
        displayName: model.displayName ?? modelId,
        provider: "gemini" as const,
      };
    })
    .filter((model) => isUsableGeminiCatalogModel(model.id));
}

export async function fetchGeminiModelsViaVertexAi(): Promise<ModelInfo[]> {
  logger.debug(
    {
      project: config.llm.gemini.vertexAi.project,
      location: config.llm.gemini.vertexAi.location,
    },
    "Fetching Gemini models via Vertex AI SDK",
  );

  const ai = createGoogleGenAIClient(undefined, "[ChatModels]");
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const discoveredModels: ModelInfo[] = [];

  for await (const model of pager) {
    const modelInfo = extractVertexGeminiModel(model);
    if (modelInfo) {
      discoveredModels.push(modelInfo);
    }
  }

  logger.debug(
    { modelCount: discoveredModels.length },
    "Fetched Gemini models via Vertex AI SDK",
  );

  const fallbackModels = await fetchVertexGeminiFallbackModels({
    ai,
    existingModelIds: new Set(discoveredModels.map((model) => model.id)),
    shouldRunFallback:
      discoveredModels.length === 0 ||
      !discoveredModels.some((model) =>
        model.id.startsWith("gemini-embedding"),
      ) ||
      !discoveredModels.some((model) => isPrimaryVertexGeminiModel(model.id)),
  });

  const candidateModels = dedupeModelsById([
    ...discoveredModels,
    ...fallbackModels,
  ]);
  const accessibleModels = await filterToAccessibleVertexModels({
    ai,
    models: candidateModels,
  });

  logger.info(
    {
      candidateCount: candidateModels.length,
      accessibleCount: accessibleModels.length,
    },
    "Filtered Vertex AI Gemini models to those the project can access",
  );

  return accessibleModels;
}

const VERTEX_GEMINI_FALLBACK_MODEL_IDS = [
  "gemini-embedding-001",
  "gemini-embedding-2-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

function extractVertexGeminiModel(model: {
  name?: string | null;
  displayName?: string | null;
}): ModelInfo | null {
  const modelId = (model.name ?? "").replace("publishers/google/models/", "");
  if (!isUsableGeminiCatalogModel(modelId)) {
    return null;
  }

  return {
    id: modelId,
    displayName: model.displayName ?? formatVertexGeminiDisplayName(modelId),
    provider: "gemini",
  };
}

async function fetchVertexGeminiFallbackModels(params: {
  ai: ReturnType<typeof createGoogleGenAIClient>;
  existingModelIds: Set<string>;
  shouldRunFallback: boolean;
}): Promise<ModelInfo[]> {
  const { ai, existingModelIds, shouldRunFallback } = params;
  if (!shouldRunFallback) {
    return [];
  }

  const candidateModelIds = VERTEX_GEMINI_FALLBACK_MODEL_IDS.filter(
    (modelId) => !existingModelIds.has(modelId),
  );

  logger.info(
    { candidateCount: candidateModelIds.length },
    "Vertex AI model list returned incomplete Gemini results, probing fallback model IDs",
  );

  const results = await Promise.allSettled(
    candidateModelIds.map(async (modelId) => {
      const model = await ai.models.get({ model: modelId });
      return extractVertexGeminiModel({
        name: model.name,
        displayName: model.displayName,
      });
    }),
  );

  const validatedModels: ModelInfo[] = [];
  for (const [index, result] of results.entries()) {
    const modelId = candidateModelIds[index];

    if (result.status === "fulfilled") {
      if (result.value) {
        validatedModels.push(result.value);
      }
      continue;
    }

    logger.debug(
      {
        modelId,
        errorMessage:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      },
      "Vertex AI Gemini fallback candidate unavailable",
    );
  }

  logger.info(
    { validatedCount: validatedModels.length },
    "Validated Vertex AI Gemini fallback models",
  );

  return validatedModels;
}

/**
 * The Vertex AI model list is the Model Garden publisher catalog, not the set
 * of models the project can invoke: gated previews (allowlist-only) and models
 * unavailable in the configured region are listed too, and `models.get` also
 * succeeds for them — only an inference-family call reveals real access. Probe
 * each candidate with `countTokens` (free — it bills nothing and generates no
 * tokens) and drop the ones the project cannot use, so the catalog never
 * advertises a model that would 404 on the first chat request.
 *
 * Only a 404 ("Publisher Model was not found or your project does not have
 * access to it") means inaccessible. Accessible embedding models answer
 * 400/501 to countTokens, and transient failures (429/5xx) must not empty the
 * catalog — every non-404 outcome keeps the model.
 */
async function filterToAccessibleVertexModels(params: {
  ai: ReturnType<typeof createGoogleGenAIClient>;
  models: ModelInfo[];
}): Promise<ModelInfo[]> {
  const { ai, models } = params;

  const probed = await Promise.all(
    models.map(async (model) => {
      try {
        await ai.models.countTokens({
          model: model.id,
          contents: "access probe",
        });
        return model;
      } catch (error) {
        if (isVertexModelInaccessibleError(error)) {
          logger.info(
            { modelId: model.id },
            "Dropping Vertex AI Gemini model the project cannot access",
          );
          return null;
        }
        return model;
      }
    }),
  );

  return probed.filter((model): model is ModelInfo => model !== null);
}

function isVertexModelInaccessibleError(error: unknown): boolean {
  // The @google/genai ApiError carries the HTTP status on `.status`; fall back
  // to the serialized response body for other error shapes.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 404;
  }
  return error instanceof Error && /"code"\s*:\s*404/.test(error.message);
}

function dedupeModelsById(models: ModelInfo[]): ModelInfo[] {
  const deduped = new Map<string, ModelInfo>();
  for (const model of models) {
    deduped.set(model.id, model);
  }
  return [...deduped.values()];
}

function formatVertexGeminiDisplayName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isPrimaryVertexGeminiModel(modelId: string): boolean {
  return VERTEX_GEMINI_FALLBACK_MODEL_IDS.includes(modelId);
}
