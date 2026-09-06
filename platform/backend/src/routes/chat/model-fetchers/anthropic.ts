import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import {
  getAzureAiFoundryBearerTokenProvider,
  isAnthropicAzureFoundryEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import config from "@/config";
import logger from "@/logging";
import type { Anthropic } from "@/types";
import { joinBaseUrl } from "@/utils/base-url";
import { type ModelInfo, modelFetchError } from "./types";

export async function fetchAnthropicModels(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  if (!apiKey && anthropicVertexClient.isEnabled()) {
    return fetchAnthropicModelsViaVertexAi();
  }

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
    throw modelFetchError("Anthropic models", response.status);
  }

  const data = (await response.json()) as {
    data: Anthropic.Types.Model[];
  };

  return data.data.map((model) => ({
    id: model.id,
    // Fall back to the id: with a base-URL override the upstream may be an
    // OpenAI-compatible or otherwise non-Anthropic-shaped server whose model
    // rows carry no display_name — leaving it undefined made the proxy's
    // /v1/models response fail its own schema (a 500 for every listing).
    displayName: model.display_name ?? model.id,
    provider: "anthropic",
    createdAt: model.created_at,
  }));
}

export async function fetchAnthropicModelsViaVertexAi(): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(
      "https://aiplatform.googleapis.com/v1beta1/publishers/anthropic/models",
    );
    url.searchParams.set("pageSize", "100");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(url, {
      headers: await anthropicVertexClient.getRequestHeaders(),
    });
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        "Failed to fetch Anthropic Vertex AI models",
      );
      throw modelFetchError("Anthropic Vertex AI models", response.status);
    }

    const data = (await response.json()) as VertexPublisherModelsResponse;
    models.push(
      ...(data.publisherModels ?? [])
        .map(toAnthropicVertexModelInfo)
        .filter((model): model is ModelInfo => model !== null),
    );
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return models;
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

interface VertexPublisherModelsResponse {
  publisherModels?: Array<{
    name?: string;
    versionId?: string;
  }>;
  nextPageToken?: string;
}

function toAnthropicVertexModelInfo(
  model: NonNullable<VertexPublisherModelsResponse["publisherModels"]>[number],
): ModelInfo | null {
  const modelId = model.name?.replace("publishers/anthropic/models/", "");
  if (!modelId?.startsWith("claude-")) {
    return null;
  }

  const versionId = model.versionId?.trim();
  const versionedModelId =
    versionId && versionId !== "default" && !modelId.includes("@")
      ? `${modelId}@${versionId}`
      : modelId;

  return {
    id: versionedModelId,
    displayName: formatAnthropicVertexModelName(modelId),
    provider: "anthropic",
  };
}

function formatAnthropicVertexModelName(modelId: string): string {
  return modelId
    .replace(/-(\d+)-(\d+)(?=-|$)/g, "-$1.$2")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
