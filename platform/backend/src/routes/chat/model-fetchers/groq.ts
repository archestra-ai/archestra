import config from "@/config";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchGroqModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.groq.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: Array<{
      id: string;
      created: number;
    }>;
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "Groq models",
    extraHeaders,
  });

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "groq",
    createdAt: new Date(model.created * 1000).toISOString(),
  }));
}
