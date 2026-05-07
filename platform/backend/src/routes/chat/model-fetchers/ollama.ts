import config from "@/config";
import logger from "@/logging";
import { isLoopbackRedirectUri } from "@/utils/network";
import { type ModelInfo, PLACEHOLDER_BEARER_TOKEN } from "./types";

const DOCKER_HOST_HINT =
  " If running inside Docker, try changing the Base URL to http://host.docker.internal:11434/ to reach Ollama on the host machine.";

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
  } catch (err) {
    const hint = isLoopbackRedirectUri(baseUrl) ? DOCKER_HOST_HINT : "";
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ url, error: message }, "Failed to connect to Ollama");
    throw new Error(`Failed to connect to Ollama at ${baseUrl}: ${message}.${hint}`);
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
