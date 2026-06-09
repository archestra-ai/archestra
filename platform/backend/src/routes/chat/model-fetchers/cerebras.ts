import config from "@/config";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchCerebrasModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cerebras.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: Array<{
      id: string;
      created: number;
    }>;
  }>({
    url: joinBaseUrl(baseUrl, "/models"),
    apiKey,
    errorLabel: "Cerebras models",
    extraHeaders,
  });

  return data.data
    .filter((model) => !model.id.toLowerCase().includes("llama"))
    .map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: "cerebras",
      createdAt: new Date(model.created * 1000).toISOString(),
    }));
}
