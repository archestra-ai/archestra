import config from "@/config";
import logger from "@/logging";
import { type ModelInfo, PLACEHOLDER_BEARER_TOKEN } from "./types";

export async function fetchVllmModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.vllm.baseUrl;
  const url = `${baseUrl}/models`;
  const response = await fetch(url, {
    headers: {
      ...(extraHeaders ?? {}),
      Authorization: apiKey ? `Bearer ${apiKey}` : PLACEHOLDER_BEARER_TOKEN,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch vLLM models",
    );
    throw new Error(`Failed to fetch vLLM models: ${response.status}`);
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
    provider: "vllm",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}
