import { isNomicModel } from "@shared";
import OpenAI from "openai";
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  buildAzureDeploymentBaseUrl,
  createAzureFetchWithApiVersion,
  normalizeAzureApiKey,
  shouldUseAzureOpenAiApiVersion,
} from "@/clients/azure-url";
import config from "@/config";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

export class AzureEmbeddingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AzureEmbeddingError";
  }
}

export async function callAzureEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { inputs, model, apiKey, baseUrl, dimensions } = params;
  const texts = inputs.map((input) => {
    if (typeof input === "string") return input;
    throw new AzureEmbeddingError(
      400,
      "Azure OpenAI embeddings do not support image inputs. Configure a multimodal embedding model to embed images.",
    );
  });

  const baseURL = buildAzureDeploymentBaseUrl({
    baseUrl: baseUrl ?? config.llm.azure.baseUrl,
    deploymentName: model,
  });
  if (!baseURL) {
    throw new AzureEmbeddingError(
      400,
      "Azure embedding base URL must point to an Azure OpenAI resource, v1 endpoint, or deployment endpoint.",
    );
  }

  const auth = await getAzureEmbeddingAuthHeaders({ apiKey, baseUrl });
  const fetchWithVersion = shouldUseAzureOpenAiApiVersion(baseUrl ?? baseURL)
    ? createAzureFetchWithApiVersion({
        apiVersion: config.llm.azure.apiVersion,
      })
    : undefined;

  const client = new OpenAI({
    apiKey: auth.openAiApiKey,
    baseURL,
    defaultHeaders: auth.headers,
    fetch: fetchWithVersion,
  });

  try {
    const response = await client.embeddings.create({
      model,
      input: texts,
      ...(dimensions !== undefined && !isNomicModel(model)
        ? { dimensions }
        : {}),
    });

    return {
      object: response.object,
      data: response.data.map((item) => ({
        object: item.object,
        embedding: item.embedding,
        index: item.index,
      })),
      model: response.model,
      usage: {
        prompt_tokens: response.usage.prompt_tokens,
        total_tokens: response.usage.total_tokens,
      },
    };
  } catch (err: unknown) {
    if (err instanceof OpenAI.APIError) {
      throw new AzureEmbeddingError(
        err.status ?? 500,
        err.message,
        extractRetryAfterMs(err),
      );
    }
    throw err;
  }
}

async function getAzureEmbeddingAuthHeaders(params: {
  apiKey: string;
  baseUrl?: string | null;
}): Promise<{
  headers: Record<string, string>;
  openAiApiKey: string;
}> {
  const normalizedApiKey = normalizeAzureApiKey(params.apiKey);
  if (normalizedApiKey && normalizedApiKey !== KEYLESS_AZURE_API_KEY) {
    return {
      headers: { "api-key": normalizedApiKey },
      openAiApiKey: normalizedApiKey,
    };
  }

  if (!isAzureOpenAiEntraIdEnabled()) {
    return {
      headers: { "api-key": normalizedApiKey ?? "" },
      openAiApiKey: normalizedApiKey ?? KEYLESS_AZURE_API_KEY,
    };
  }

  const tokenProvider = getAzureOpenAiBearerTokenProvider(
    params.baseUrl ?? undefined,
  );
  const token = await tokenProvider();
  return {
    headers: { Authorization: `Bearer ${token}` },
    openAiApiKey: KEYLESS_AZURE_API_KEY,
  };
}

const KEYLESS_AZURE_API_KEY = "unused";

function extractRetryAfterMs(
  error: InstanceType<typeof OpenAI.APIError>,
): number | undefined {
  const retryAfterHeader = getHeaderValue(error.headers, "retry-after");
  const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? "", 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterMatch = error.message.match(/retry after\s+(\d+)\s+seconds/i);
  if (!retryAfterMatch) return undefined;

  const retryAfterFromMessage = Number.parseInt(retryAfterMatch[1], 10);
  return Number.isFinite(retryAfterFromMessage) && retryAfterFromMessage >= 0
    ? retryAfterFromMessage * 1000
    : undefined;
}

function getHeaderValue(
  headers:
    | Headers
    | Record<string, unknown>
    | { get(name: string): string | null | undefined }
    | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name) ?? undefined;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}
