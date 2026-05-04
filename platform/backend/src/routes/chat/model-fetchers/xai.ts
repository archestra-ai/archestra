import config from "@/config";
import type { OpenAi } from "@/types";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchXaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.xai.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel)[];
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "xAI models",
    extraHeaders,
  });

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "xai",
    createdAt:
      "created" in model && typeof model.created === "number"
        ? new Date(model.created * 1000).toISOString()
        : undefined,
  }));
}
