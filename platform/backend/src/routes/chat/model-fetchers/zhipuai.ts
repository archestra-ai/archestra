import config from "@/config";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import type { ModelInfo } from "./types";

export async function fetchZhipuaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.zhipuai.baseUrl;
  const data = await fetchModelsWithBearerAuth<{
    data: Array<{
      id: string;
      created: number;
    }>;
  }>({
    url: `${baseUrl}/models`,
    apiKey,
    errorLabel: "Zhipuai models",
    extraHeaders,
  });

  const chatModelPrefixes = ["glm-", "chatglm-"];
  const excludePatterns = ["-embedding"];

  const apiModels = data.data
    .filter((model) => {
      const id = model.id.toLowerCase();
      const hasValidPrefix = chatModelPrefixes.some((prefix) =>
        id.startsWith(prefix),
      );
      if (!hasValidPrefix) {
        return false;
      }

      return !excludePatterns.some((pattern) => id.includes(pattern));
    })
    .map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: "zhipuai" as const,
      createdAt: new Date(model.created * 1000).toISOString(),
    }));

  const freeModels: ModelInfo[] = [
    {
      id: "glm-4.5-flash",
      displayName: "glm-4.5-flash",
      provider: "zhipuai",
      createdAt: new Date().toISOString(),
    },
  ];

  const existingIds = new Set(apiModels.map((model) => model.id.toLowerCase()));
  const allModels = [];

  for (const freeModel of freeModels) {
    if (!existingIds.has(freeModel.id.toLowerCase())) {
      allModels.push(freeModel);
    }
  }

  allModels.push(...apiModels);

  return allModels;
}
