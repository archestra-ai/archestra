import config from "@/config";
import logger from "@/logging";
import type { ModelInfo } from "./types";

export async function fetchCohereModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cohere.baseUrl;
  const url = `${baseUrl}/v2/models`;

  const response = await fetch(url, {
    headers: {
      ...(extraHeaders ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Cohere models",
    );
    throw new Error(`Failed to fetch Cohere models: ${response.status}`);
  }

  const data = (await response.json()) as {
    models: Array<{
      name: string;
      endpoints?: string[];
      created_at?: string;
    }>;
  };

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
