import { isUsableGeminiCatalogModel } from "@archestra/shared";
import type { GoogleGenAI } from "@google/genai";
import {
  createVertexClientForLocation,
  isVertexModelReachable,
  resolveVertexLocation,
  VERTEX_GLOBAL_LOCATION,
} from "@/clients/gemini-client";
import config from "@/config";
import logger from "@/logging";
import type { Gemini } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { type ModelInfo, modelFetchError } from "./types";

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
    throw modelFetchError("Gemini models", response.status);
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
  const { project, location, allowGlobalEndpoint } = config.llm.gemini.vertexAi;

  logger.debug(
    { project, location, allowGlobalEndpoint },
    "Fetching Gemini models via Vertex AI SDK",
  );

  const clientForModel = createVertexClientResolver();
  const discoveredModels = await listVertexGeminiModels();

  logger.debug(
    { modelCount: discoveredModels.length },
    "Fetched Gemini models via Vertex AI SDK",
  );

  const fallbackModels = await fetchVertexGeminiFallbackModels({
    clientForModel,
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
  const reachableModels = filterToConfiguredVertexLocations(candidateModels);
  const accessibleModels = await filterToAccessibleVertexModels({
    clientForModel,
    models: reachableModels,
  });

  logger.info(
    {
      candidateCount: candidateModels.length,
      reachableCount: reachableModels.length,
      accessibleCount: accessibleModels.length,
    },
    "Filtered Vertex AI Gemini models to those the project can access",
  );

  return accessibleModels;
}

const VERTEX_GEMINI_FALLBACK_MODEL_IDS = [
  "gemini-embedding-001",
  "gemini-embedding-2",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

type VertexClientResolver = (modelId: string) => GoogleGenAI;

/**
 * One client per Vertex location, built on first use and reused for every model
 * that resolves to it. Two at most — the configured location and `global` — so
 * a refresh does not rebuild an authenticated client per model.
 */
function createVertexClientResolver(): VertexClientResolver {
  const clientsByLocation = new Map<string, GoogleGenAI>();

  return (modelId: string) => {
    const location = resolveVertexLocation(modelId);
    const existing = clientsByLocation.get(location);
    if (existing) {
      return existing;
    }

    const client = createVertexClientForLocation(
      location,
      "[ChatModels]",
      modelId,
    );
    clientsByLocation.set(location, client);
    return client;
  };
}

/**
 * Every Gemini-family model the configured locations publish. The regional and
 * global catalogs are not nested — Gemma MaaS and `gemini-embedding-001` appear
 * only regionally, and a global-only generation may be listed only globally —
 * so both are read and merged when the global endpoint is in play.
 */
async function listVertexGeminiModels(): Promise<ModelInfo[]> {
  const { location, allowGlobalEndpoint } = config.llm.gemini.vertexAi;
  const locations = new Set([location]);
  if (allowGlobalEndpoint) {
    locations.add(VERTEX_GLOBAL_LOCATION);
  }

  const perLocation = await Promise.all(
    [...locations].map(async (vertexLocation) => {
      const client = createVertexClientForLocation(
        vertexLocation,
        "[ChatModels]",
      );
      const models: ModelInfo[] = [];
      try {
        const pager = await client.models.list({ config: { pageSize: 100 } });
        for await (const model of pager) {
          const modelInfo = extractVertexGeminiModel(model);
          if (modelInfo) {
            models.push(modelInfo);
          }
        }
      } catch (error) {
        // One unreachable location must not empty the catalog: the other still
        // has models, and the accessibility probe vets whatever comes back.
        logger.warn(
          {
            location: vertexLocation,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to list Vertex AI Gemini models for location",
        );
      }
      return models;
    }),
  );

  return dedupeModelsById(perLocation.flat());
}

/**
 * Drops models no configured location can serve. Without the global endpoint
 * enabled, that is every Gemini 3+ generation — they are listed in the regional
 * Model Garden catalog but 404 on use, which is precisely the trap this filter
 * exists to avoid. Logged by name, because "the new Gemini models are missing"
 * is otherwise indistinguishable from a broken key.
 */
function filterToConfiguredVertexLocations(models: ModelInfo[]): ModelInfo[] {
  const reachable: ModelInfo[] = [];
  const globalOnly: string[] = [];

  for (const model of models) {
    if (isVertexModelReachable(model.id)) {
      reachable.push(model);
    } else {
      globalOnly.push(model.id);
    }
  }

  if (globalOnly.length > 0) {
    logger.info(
      {
        modelIds: globalOnly,
        configuredLocation: config.llm.gemini.vertexAi.location,
      },
      "Skipping Vertex AI Gemini models that only the global endpoint serves; " +
        "set ARCHESTRA_GEMINI_VERTEX_AI_ALLOW_GLOBAL_ENDPOINT=true to use them",
    );
  }

  return reachable;
}

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
  clientForModel: VertexClientResolver;
  existingModelIds: Set<string>;
  shouldRunFallback: boolean;
}): Promise<ModelInfo[]> {
  const { clientForModel, existingModelIds, shouldRunFallback } = params;
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
      const model = await clientForModel(modelId).models.get({
        model: modelId,
      });
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
  clientForModel: VertexClientResolver;
  models: ModelInfo[];
}): Promise<ModelInfo[]> {
  const { clientForModel, models } = params;

  const probed = await Promise.all(
    models.map(async (model) => {
      try {
        await clientForModel(model.id).models.countTokens({
          model: model.id,
          contents: "access probe",
        });
        return model;
      } catch (error) {
        if (isVertexModelInaccessibleError(error)) {
          logger.info(
            { modelId: model.id, location: resolveVertexLocation(model.id) },
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
