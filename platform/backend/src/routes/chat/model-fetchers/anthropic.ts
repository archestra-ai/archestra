import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import {
  getAzureAiFoundryBearerTokenProvider,
  isAnthropicAzureFoundryEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import config from "@/config";
import logger from "@/logging";
import type { Anthropic } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import type { ModelInfo } from "./types";

export async function fetchAnthropicModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.anthropic.baseUrl;
  const url = joinBaseUrl(baseUrl, "/v1/models?limit=100");

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

/**
 * Build the auth headers for a direct Anthropic HTTP call: `x-api-key` for a
 * real key, else the Azure-Foundry-Entra or Workload-Identity bearer when those
 * keyless modes are enabled. Shared with the credit-probe helper.
 */
export async function getAnthropicAuthHeaders(
  apiKey: string | undefined,
): Promise<Record<string, string>> {
  if (apiKey) {
    return { "x-api-key": apiKey };
  }

  if (isAnthropicAzureFoundryEntraIdEnabled()) {
    const tokenProvider = getAzureAiFoundryBearerTokenProvider();
    return { Authorization: `Bearer ${await tokenProvider()}` };
  }

  if (anthropicWorkloadIdentity.isEnabled()) {
    return {
      Authorization: `Bearer ${await anthropicWorkloadIdentity.getAccessToken()}`,
    };
  }

  return { "x-api-key": "" };
}
