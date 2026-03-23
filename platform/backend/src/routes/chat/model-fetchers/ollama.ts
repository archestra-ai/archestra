import config from "@/config";
import logger from "@/logging";
import type { ModelInfo } from "./types";

export async function fetchOllamaModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.ollama.baseUrl;
  const url = `${baseUrl}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: apiKey ? `Bearer ${apiKey}` : "Bearer EMPTY",
    },
  });

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
