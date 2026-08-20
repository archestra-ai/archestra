import { requiresGlobalVertexEndpoint } from "@archestra/shared";
import { GoogleGenAI } from "@google/genai";
import config from "@/config";
import logger from "@/logging";

/** Vertex AI's worldwide endpoint, addressed as a location like any region. */
export const VERTEX_GLOBAL_LOCATION = "global";

/**
 * Creates a GoogleGenAI client based on configuration.
 * Supports two modes:
 * 1. Vertex AI mode: Uses ADC (Application Default Credentials) or service account key file
 * 2. API key mode: Uses the provided API key (default, for Google AI Studio)
 *
 * For Vertex AI authentication, the SDK uses google-auth-library which supports:
 * - Service account key file (via ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE)
 * - Workload Identity on GKE (automatic)
 * - Attached service account on GCE/Cloud Run (automatic)
 * - User credentials from `gcloud auth application-default login` (for local dev)
 *
 * @param apiKey - API key (optional when Vertex AI is enabled)
 * @param logPrefix - Prefix for log messages (e.g., "[GeminiProxy]", "[dualLlmClient]")
 * @param baseUrlOverride - Base URL override (API key mode only)
 * @param modelId - Model the client will be used for, so Vertex AI mode can
 *   pick the location that actually serves it (see {@link resolveVertexLocation}).
 *   Omitting it keeps the configured location, which is right for
 *   catalog-listing calls that are not about one model.
 * @returns GoogleGenAI client instance
 * @throws Error if Vertex AI is enabled but project is not set
 * @throws Error if API key is not provided when Vertex AI is disabled
 */
export function createGoogleGenAIClient(
  apiKey: string | undefined,
  logPrefix = "[Gemini]",
  baseUrlOverride?: string | null,
  modelId?: string | null,
): GoogleGenAI {
  const { vertexAi } = config.llm.gemini;

  if (vertexAi.enabled) {
    if (!vertexAi.project) {
      throw new Error(
        "Vertex AI is enabled but ARCHESTRA_GEMINI_VERTEX_AI_PROJECT is not set",
      );
    }

    return createVertexClientForLocation(
      resolveVertexLocation(modelId),
      logPrefix,
      modelId,
    );
  }

  // API key mode (default) - requires API key
  if (!apiKey) {
    throw new Error(
      "API key required for Gemini when Vertex AI mode is disabled",
    );
  }

  logger.debug(
    { baseUrl: baseUrlOverride || config.llm.gemini.baseUrl },
    `${logPrefix} Initializing GoogleGenAI with API key mode`,
  );

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: baseUrlOverride || config.llm.gemini.baseUrl,
      apiVersion: "v1beta",
    },
  });
}

/**
 * Build a Vertex AI client pinned to an explicit location, for callers that
 * address a location directly rather than deriving one from a model — the model
 * fetcher, which lists each location's catalog and probes candidates at the
 * location they would actually be served from.
 *
 * @throws Error if Vertex AI is enabled but project is not set
 */
export function createVertexClientForLocation(
  location: string,
  logPrefix = "[Gemini]",
  modelId?: string | null,
): GoogleGenAI {
  const { vertexAi } = config.llm.gemini;

  if (!vertexAi.project) {
    throw new Error(
      "Vertex AI is enabled but ARCHESTRA_GEMINI_VERTEX_AI_PROJECT is not set",
    );
  }

  const hasCredentialsFile = vertexAi.credentialsFile !== "";

  logger.debug(
    {
      project: vertexAi.project,
      location,
      configuredLocation: vertexAi.location,
      modelId,
      hasCredentialsFile,
    },
    `${logPrefix} Initializing GoogleGenAI with Vertex AI mode`,
  );

  // Always pass projectId in googleAuthOptions to ensure the correct GCP project
  // is used for API calls. Without this, ADC may use a different project from the
  // credentials. If credentialsFile is provided, also pass it via keyFilename.
  return new GoogleGenAI({
    vertexai: true,
    project: vertexAi.project,
    location,
    googleAuthOptions: {
      projectId: vertexAi.project,
      ...(hasCredentialsFile && {
        keyFilename: vertexAi.credentialsFile,
      }),
    },
  });
}

/**
 * Check if Vertex AI mode is enabled
 */
export function isVertexAiEnabled(): boolean {
  return config.llm.gemini.vertexAi.enabled;
}

/**
 * The Vertex AI location a model should be addressed at: the configured one,
 * except for models Vertex serves only from `global` — those go to `global`
 * when the deployment allows it.
 *
 * A single configured location cannot serve the whole catalog: from Gemini 3 on
 * the generations are global-only, while Gemma MaaS and `gemini-embedding-001`
 * are regional-only and absent from the global catalog. Resolving per model is
 * what lets one deployment reach both sets.
 */
export function resolveVertexLocation(modelId?: string | null): string {
  const { location, allowGlobalEndpoint } = config.llm.gemini.vertexAi;

  if (location === VERTEX_GLOBAL_LOCATION) {
    return location;
  }
  if (!modelId || !allowGlobalEndpoint) {
    return location;
  }
  return requiresGlobalVertexEndpoint(modelId)
    ? VERTEX_GLOBAL_LOCATION
    : location;
}

/**
 * Whether a model is reachable at all under the current Vertex configuration.
 * False only for a global-only model on a deployment that pinned a region and
 * has not opted into the global endpoint — the case where the catalog should
 * leave the model out rather than advertise one every request would 404 on.
 */
export function isVertexModelReachable(modelId: string): boolean {
  const { location, allowGlobalEndpoint } = config.llm.gemini.vertexAi;

  if (location === VERTEX_GLOBAL_LOCATION || allowGlobalEndpoint) {
    return true;
  }
  return !requiresGlobalVertexEndpoint(modelId);
}
