import config from "@/config";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchDeepSeekModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.deepseek.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data?: Array<{
      id: string;
      created?: number;
    }>;
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "DeepSeek models",
    extraHeaders,
  });

  return (Array.isArray(data.data) ? data.data : []).map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "deepseek",
    createdAt:
      model.created != null
        ? new Date(model.created * 1000).toISOString()
        : new Date(0).toISOString(),
  }));
}
