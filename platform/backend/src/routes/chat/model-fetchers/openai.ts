import config from "@/config";
import type { OpenAi } from "@/types";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export function mapOpenAiModelToModelInfo(
  model: OpenAi.Types.Model | OpenAi.Types.OrlandoModel,
): ModelInfo {
  let provider: ModelInfo["provider"] = "openai";

  if (!("owned_by" in model)) {
    if (model.id.startsWith("claude-")) {
      provider = "anthropic";
    } else if (model.id.startsWith("gemini-")) {
      provider = "gemini";
    }
  }

  return {
    id: model.id,
    displayName: "name" in model ? model.name : model.id,
    provider,
    createdAt:
      "created" in model
        ? new Date(model.created * 1000).toISOString()
        : undefined,
  };
}

export async function fetchOpenAiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.openai.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel)[];
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "OpenAI models",
    extraHeaders,
  });

  const excludePatterns = [
    "instruct",
    "tts",
    "whisper",
    "image",
    "audio",
    "sora",
    "dall-e",
  ];

  return data.data
    .filter((model) => {
      const id = model.id.toLowerCase();
      return !excludePatterns.some((pattern) => id.includes(pattern));
    })
    .map(mapOpenAiModelToModelInfo);
}
