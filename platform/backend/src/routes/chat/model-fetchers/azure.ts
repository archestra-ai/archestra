import {
  getAzureManagementBearerTokenProvider,
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
    const deployments = await tryAzureManagementDeployments(baseUrl);
    if (deployments.length > 0) {
      return deployments;
    }

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
        const deployments = await tryAzureManagementDeployments(baseUrl, {
          warnOnEmpty: true,
        });
        if (deployments.length > 0) {
          return deployments;
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
      const deployments = await tryAzureManagementDeployments(baseUrl, {
        warnOnEmpty: true,
      });
      if (deployments.length > 0) {
        return deployments;
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

async function tryAzureManagementDeployments(
  baseUrl: string,
  options?: { warnOnEmpty?: boolean },
): Promise<ModelInfo[]> {
  const deployments = await fetchAzureManagementDeployments(baseUrl);
  if (deployments.length === 0 && options?.warnOnEmpty) {
    logger.warn(
      { baseUrl },
      "Azure deployment discovery failed and management deployment discovery returned no deployments; not falling back to the model catalog for resource-level Azure OpenAI URL",
    );
  }

  return deployments;
}

async function fetchAzureManagementDeployments(
  baseUrl: string,
): Promise<ModelInfo[]> {
  if (!isAzureOpenAiEntraIdEnabled()) {
    return [];
  }

  const accountName = extractAzureResourceName(baseUrl);
  if (!accountName) {
    return [];
  }

  try {
    const tokenProvider = getAzureManagementBearerTokenProvider();
    const headers = { Authorization: `Bearer ${await tokenProvider()}` };
    const subscriptions = await fetchAzureSubscriptions(headers);
    let accountResourceIds = await fetchAzureCognitiveServicesAccountIds({
      accountName,
      subscriptions,
      headers,
    });
    if (accountResourceIds.length === 0) {
      accountResourceIds =
        await fetchAzureCognitiveServicesAccountIdsForProject({
          projectName: accountName,
          subscriptions,
          headers,
        });
    }

    for (const accountResourceId of accountResourceIds) {
      const deployments = await fetchAzureManagementDeploymentsForAccount({
        accountResourceId,
        headers,
      });
      if (deployments.length > 0) {
        return deployments;
      }
    }
  } catch (error) {
    logger.error({ error }, "Error fetching Azure deployments from management");
  }

  return [];
}

async function fetchAzureCognitiveServicesAccountIds(params: {
  accountName: string;
  subscriptions: string[];
  headers: Record<string, string>;
}): Promise<string[]> {
  const safeAccountName = params.accountName.replace(/'/g, "''");
  const filter = `resourceType eq 'Microsoft.CognitiveServices/accounts' and name eq '${safeAccountName}'`;
  const resources = await fetchAzureResourcesForSubscriptions({
    subscriptions: params.subscriptions,
    headers: params.headers,
    filter,
    errorMessage: "Failed to find Azure Cognitive Services account",
  });

  return resources
    .map((resource) => resource.id)
    .filter((id): id is string => Boolean(id));
}

async function fetchAzureCognitiveServicesAccountIdsForProject(params: {
  projectName: string;
  subscriptions: string[];
  headers: Record<string, string>;
}): Promise<string[]> {
  const resources = await fetchAzureResourcesForSubscriptions({
    subscriptions: params.subscriptions,
    headers: params.headers,
    filter: "resourceType eq 'Microsoft.CognitiveServices/accounts/projects'",
    errorMessage: "Failed to find Azure Cognitive Services project",
  });

  return [
    ...new Set(
      resources
        .filter((resource) =>
          isAzureProjectResourceIdForProject(resource.id, params.projectName),
        )
        .map((resource) => extractAccountResourceIdFromProjectId(resource.id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

async function fetchAzureSubscriptions(
  headers: Record<string, string>,
): Promise<string[]> {
  const url = new URL("https://management.azure.com/subscriptions");
  url.searchParams.set("api-version", "2020-01-01");

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Azure subscriptions",
    );
    return [];
  }

  const data = (await response.json()) as {
    value?: { subscriptionId?: string }[];
  };
  return (data.value ?? [])
    .map((subscription) => subscription.subscriptionId)
    .filter((subscriptionId): subscriptionId is string =>
      Boolean(subscriptionId),
    );
}

async function fetchAzureResourcesForSubscriptions(params: {
  subscriptions: string[];
  headers: Record<string, string>;
  filter: string;
  errorMessage: string;
}): Promise<{ id?: string }[]> {
  const resourceLists = await Promise.all(
    params.subscriptions.map(async (subscriptionId) => {
      const url = new URL(
        `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/resources`,
      );
      url.searchParams.set("api-version", "2021-04-01");
      url.searchParams.set("$filter", params.filter);

      const response = await fetch(url, { headers: params.headers });
      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, error: errorText, subscriptionId },
          params.errorMessage,
        );
        return [];
      }

      const data = (await response.json()) as { value?: { id?: string }[] };
      return data.value ?? [];
    }),
  );

  return resourceLists.flat();
}

async function fetchAzureManagementDeploymentsForAccount(params: {
  accountResourceId: string;
  headers: Record<string, string>;
}): Promise<ModelInfo[]> {
  if (!isAzureAccountResourceId(params.accountResourceId)) {
    logger.error(
      { accountResourceId: params.accountResourceId },
      "Unexpected Azure Cognitive Services account resource ID",
    );
    return [];
  }

  const url = new URL(
    `https://management.azure.com${params.accountResourceId}/deployments`,
  );
  url.searchParams.set("api-version", "2024-10-01");

  const response = await fetch(url, { headers: params.headers });
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Azure deployments from management",
    );
    return [];
  }

  const data = (await response.json()) as {
    value?: {
      name?: string;
      properties?: { provisioningState?: string };
    }[];
  };

  return (data.value ?? [])
    .filter(
      (deployment) => deployment.properties?.provisioningState !== "Failed",
    )
    .map((deployment) => deployment.name)
    .filter((name): name is string => Boolean(name))
    .map((name) => ({
      id: name,
      displayName: name,
      provider: "azure" as const,
    }));
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

function extractAzureResourceName(baseUrl: string): string | null {
  try {
    const hostname = new URL(baseUrl).hostname;
    for (const suffix of AZURE_RESOURCE_HOST_SUFFIXES) {
      if (hostname.endsWith(suffix)) {
        return hostname.slice(0, -suffix.length);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isAzureProjectResourceIdForProject(
  projectResourceId: string | undefined,
  projectName: string,
): boolean {
  if (!projectResourceId) {
    return false;
  }

  const segments = projectResourceId.split("/");
  const projectsIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "projects",
  );
  if (projectsIndex === -1) {
    return false;
  }

  return (
    segments[projectsIndex + 1]?.toLowerCase() === projectName.toLowerCase()
  );
}

function extractAccountResourceIdFromProjectId(
  projectResourceId: string | undefined,
): string | null {
  if (!projectResourceId) {
    return null;
  }

  const match = projectResourceId.match(
    /^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+)\/projects\/[^/]+$/i,
  );
  return match?.[1] ?? null;
}

function isAzureAccountResourceId(accountResourceId: string): boolean {
  return /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+$/i.test(
    accountResourceId,
  );
}

const AZURE_RESOURCE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
];
