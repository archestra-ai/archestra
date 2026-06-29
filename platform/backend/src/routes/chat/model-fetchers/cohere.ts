import config from "@/config";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchCohereModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cohere.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    models: Array<{
      name: string;
      endpoints?: string[];
      created_at?: string;
    }>;
  }>({
    url: joinBaseUrl(baseUrl, "/v2/models"),
    apiKey,
    errorLabel: "Cohere models",
    extraHeaders,
  });

  return data.models
    .filter((model) => {
      const endpoints = model.endpoints || [];
      return endpoints.includes("chat") || endpoints.includes("generate");
    })
    .map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: "cohere" as const,
      createdAt: model.created_at,
    }))
    .sort((a, b) => {
      const preferredModel = "command-r-08-2024";
      if (a.id === preferredModel) return -1;
      if (b.id === preferredModel) return 1;
      return a.id.localeCompare(b.id);
    });
}
