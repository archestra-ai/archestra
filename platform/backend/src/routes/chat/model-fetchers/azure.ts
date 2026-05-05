import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  buildAzureDeploymentsUrl,
  extractAzureDeploymentName,
  normalizeAzureApiKey,
} from "@/clients/azure-url";
import config from "@/config";
import logger from "@/logging";
import type { ModelInfo } from "./types";

export async function fetchAzureModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.azure.baseUrl;
  if (!baseUrl) {
    return [];
  }

  const url = buildAzureDeploymentsUrl({
    apiVersion: config.llm.azure.apiVersion,
    baseUrl,
  });
  const deploymentName = extractAzureDeploymentName(baseUrl);
  if (!url) {
    logger.warn({ baseUrl }, "Could not extract Azure endpoint from baseUrl");
    return [];
  }

  try {
    // Azure lists deployments at GET /openai/deployments?api-version=...
    // and returns { data: [{ id, ... }] }, which we map into ModelInfo.
    const authHeaders = await getAzureAuthHeaders(apiKey);
    const response = await fetch(url, {
      headers: {
        ...(extraHeaders ?? {}),
        ...authHeaders,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        "Failed to fetch Azure deployments",
      );
      return fallbackToConfiguredDeployment(deploymentName);
    }

    const data = (await response.json()) as { data?: { id: string }[] };
    const models = (data.data ?? []).map((dep) => ({
      id: dep.id,
      displayName: dep.id,
      provider: "azure" as const,
    }));
    return models.length > 0
      ? models
      : fallbackToConfiguredDeployment(deploymentName);
  } catch (error) {
    logger.error({ error }, "Error fetching Azure deployments");
    return fallbackToConfiguredDeployment(deploymentName);
  }
}

async function getAzureAuthHeaders(
  apiKey: string | undefined,
): Promise<Record<string, string>> {
  if (apiKey) {
    return { "api-key": normalizeAzureApiKey(apiKey) ?? "" };
  }

  if (!isAzureOpenAiEntraIdEnabled()) {
    return { "api-key": "" };
  }

  const tokenProvider = getAzureOpenAiBearerTokenProvider();
  return { Authorization: `Bearer ${await tokenProvider()}` };
}

function fallbackToConfiguredDeployment(
  deploymentName: string | null,
): ModelInfo[] {
  if (!deploymentName) {
    return [];
  }

  return [
    {
      id: deploymentName,
      displayName: deploymentName,
      provider: "azure",
    },
  ];
}
