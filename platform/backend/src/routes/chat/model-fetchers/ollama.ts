import { isLocalhostUrl, OLLAMA_DOCKER_HOST_URL } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { type ModelInfo, PLACEHOLDER_BEARER_TOKEN } from "./types";

export async function fetchOllamaModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.ollama.baseUrl;
  const url = `${baseUrl}/models`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        ...(extraHeaders ?? {}),
        Authorization: apiKey ? `Bearer ${apiKey}` : PLACEHOLDER_BEARER_TOKEN,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ baseUrl, error: message }, "Failed to connect to Ollama");
    throw new Error(buildOllamaConnectError(baseUrl, message));
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Ollama models",
    );
    throw new Error(`Failed to fetch Ollama models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created?: number;
    }>;
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "ollama",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}

function buildOllamaConnectError(baseUrl: string, reason: string): string {
  if (isLocalhostUrl(baseUrl)) {
    return (
      `Cannot reach Ollama at ${baseUrl} (${reason}). ` +
      `If Archestra runs in Docker or Kubernetes, "localhost" points at the container, ` +
      `not the host machine. Try ${OLLAMA_DOCKER_HOST_URL} instead.`
    );
  }
  return `Cannot reach Ollama at ${baseUrl}: ${reason}`;
}
