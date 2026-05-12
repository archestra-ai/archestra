import {
  getAzureAiFoundryBearerTokenProvider,
  isAnthropicAzureFoundryEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  getAnthropicWifAccessToken,
  isAnthropicWifEnabled,
} from "@/clients/anthropic-wif-credentials";
import config from "@/config";
import logger from "@/logging";
import type { Anthropic } from "@/types";
import type { ModelInfo } from "./types";

export async function fetchAnthropicModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.anthropic.baseUrl;
  const url = `${baseUrl}/v1/models?limit=100`;

  const response = await fetch(url, {
    headers: {
      ...(extraHeaders ?? {}),
      ...(await getAnthropicAuthHeaders(apiKey)),
      "anthropic-version": "2023-06-01",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Anthropic models",
    );
    throw new Error(`Failed to fetch Anthropic models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Anthropic.Types.Model[];
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.display_name,
    provider: "anthropic",
    createdAt: model.created_at,
  }));
}

async function getAnthropicAuthHeaders(
  apiKey: string | undefined,
): Promise<Record<string, string>> {
  // 1. Explicit API key takes precedence
  if (apiKey) {
    return { "x-api-key": apiKey };
  }

  // 2. Workload Identity Federation (keyless auth)
  if (isAnthropicWifEnabled()) {
    const accessToken = await getAnthropicWifAccessToken();
    return { Authorization: `Bearer ${accessToken}` };
  }

  // 3. Azure AI Foundry Entra ID
  if (isAnthropicAzureFoundryEntraIdEnabled()) {
    const tokenProvider = getAzureAiFoundryBearerTokenProvider();
    return { Authorization: `Bearer ${await tokenProvider()}` };
  }

  // 4. Fallback: no auth
  return { "x-api-key": "" };
}
