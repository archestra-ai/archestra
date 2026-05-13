import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  buildAzureDeploymentsUrl,
  buildAzureModelsUrl,
  buildAzureOpenAiV1ModelsUrl,
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
  const v1ModelsUrl = buildAzureOpenAiV1ModelsUrl(baseUrl);
  const modelsUrl = buildAzureModelsUrl({
    apiVersion: config.llm.azure.apiVersion,
    baseUrl,
  });
  if (v1ModelsUrl) {
    return fetchAzureModelList({
      apiKey,
      extraHeaders,
      url: v1ModelsUrl,
      baseUrl,
    });
  }

  if (!url) {
    logger.warn({ baseUrl }, "Could not extract Azure endpoint from baseUrl");
    return [];
  }

  try {
    // Azure lists deployments at GET /openai/deployments?api-version=...
    // and returns { data: [{ id, ... }] }, which we map into ModelInfo.
    const authHeaders = await getAzureAuthHeaders(apiKey, baseUrl);
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
      if (modelsUrl) {
        const models = await fetchAzureModelList({
          apiKey,
          extraHeaders,
          url: modelsUrl,
          baseUrl,
        });
        if (models.length > 0) {
          return models;
        }
      }
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
    if (modelsUrl) {
      const models = await fetchAzureModelList({
        apiKey,
        extraHeaders,
        url: modelsUrl,
        baseUrl,
      });
      if (models.length > 0) {
        return models;
      }
    }
    return fallbackToConfiguredDeployment(deploymentName);
  }
}

async function fetchAzureModelList(params: {
  apiKey: string;
  baseUrl: string;
  extraHeaders?: Record<string, string> | null;
  url: string;
}): Promise<ModelInfo[]> {
  try {
    const authHeaders = await getAzureAuthHeaders(
      params.apiKey,
      params.baseUrl,
    );
    const response = await fetch(params.url, {
      headers: {
        ...(params.extraHeaders ?? {}),
        ...authHeaders,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        "Failed to fetch Azure models",
      );
      return [];
    }

    const data = (await response.json()) as {
      data?: {
        id: string;
        capabilities?: { chat_completion?: boolean };
      }[];
    };

    return (data.data ?? [])
      .filter(
        (model) =>
          model.capabilities?.chat_completion !== false ||
          isAzureEmbeddingModelId(model.id),
      )
      .map((model) => ({
        id: model.id,
        displayName: model.id,
        provider: "azure" as const,
      }));
  } catch (error) {
    logger.error({ error }, "Error fetching Azure models");
    return [];
  }
}

async function getAzureAuthHeaders(
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<Record<string, string>> {
  if (apiKey) {
    return { "api-key": normalizeAzureApiKey(apiKey) ?? "" };
  }

  if (!isAzureOpenAiEntraIdEnabled()) {
    return { "api-key": "" };
  }

  const tokenProvider = getAzureOpenAiBearerTokenProvider(baseUrl);
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

function isAzureEmbeddingModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("embedding");
}
