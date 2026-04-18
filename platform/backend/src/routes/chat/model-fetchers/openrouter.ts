import config from "@/config";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchOpenrouterModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.openrouter.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: Array<{ id: string; created?: number }>;
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "OpenRouter models",
  });

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "openrouter",
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}
