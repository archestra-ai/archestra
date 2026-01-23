import { GoogleGenAI } from "@google/genai";
import config from "@/config";
import logger from "@/logging";

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
 * @returns GoogleGenAI client instance
 * @throws Error if Vertex AI is enabled but project is not set
 * @throws Error if API key is not provided when Vertex AI is disabled
 */
export function createGoogleGenAIClient(
  apiKey: string | undefined,
  logPrefix = "[Gemini]",
): GoogleGenAI {
  const { vertexAi } = config.llm.gemini;

  if (vertexAi.enabled) {
    if (!vertexAi.project) {
      throw new Error(
        "Vertex AI is enabled but ARCHESTRA_GEMINI_VERTEX_AI_PROJECT is not set",
      );
    }

    const hasCredentialsFile = vertexAi.credentialsFile !== "";

    logger.debug(
      {
        project: vertexAi.project,
        location: vertexAi.location,
        hasCredentialsFile,
      },
      `${logPrefix} Initializing GoogleGenAI with Vertex AI mode`,
    );

    // Build the client config
    // Always pass projectId in googleAuthOptions to ensure the correct GCP project is used
    // for API calls. Without this, ADC may use a different project from the credentials.
    // If credentialsFile is provided, also pass it via keyFilename.
    return new GoogleGenAI({
      vertexai: true,
      project: vertexAi.project,
      location: vertexAi.location,
      googleAuthOptions: {
        projectId: vertexAi.project,
        ...(hasCredentialsFile && {
          keyFilename: vertexAi.credentialsFile,
        }),
      },
    });
  }

  // API key mode (default) - requires API key
  if (!apiKey) {
    throw new Error(
      "API key required for Gemini when Vertex AI mode is disabled",
    );
  }

  logger.debug(
    { baseUrl: config.llm.gemini.baseUrl },
    `${logPrefix} Initializing GoogleGenAI with API key mode`,
  );

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: config.llm.gemini.baseUrl,
      apiVersion: "v1beta",
    },
  });
}

/**
 * Check if Vertex AI mode is enabled
 */
export function isVertexAiEnabled(): boolean {
  return config.llm.gemini.vertexAi.enabled;
}
