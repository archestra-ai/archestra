import {
  MINIMAX_MODELS,
  PERPLEXITY_MODELS,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared";
import { AwsV4Signer } from "aws4fetch";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getBedrockCredentialProvider,
  getBedrockRegion,
  isBedrockIamAuthEnabled,
} from "@/clients/bedrock-credentials";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import {
  ApiKeyModelModel,
  ChatApiKeyModel,
  ModelModel,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import {
  type Anthropic,
  ApiError,
  constructResponseSchema,
  type Gemini,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  type OpenAi,
  PatchModelBodySchema,
  SelectModelSchema,
  UuidIdSchema,
} from "@/types";

// Response schema for models
const ChatModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedProvidersSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  isBest: z.boolean().optional(),
  isFastest: z.boolean().optional(),
});

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
  capabilities?: ModelCapabilities;
}

/**
 * Fetch models from xAI API (OpenAI-compatible)
 */
async function fetchXaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.xai.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch xAI models",
    );
    throw new Error(`Failed to fetch xAI models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel)[];
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "xai" as const,
    createdAt:
      "created" in model && typeof model.created === "number"
        ? new Date(model.created * 1000).toISOString()
        : undefined,
  }));
}

/**
 * Fetch models from Anthropic API
 */
async function fetchAnthropicModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.anthropic.baseUrl;
  const url = `${baseUrl}/v1/models?limit=100`;

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
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

  // All Anthropic models are chat models, no filtering needed
  return data.data.map((model) => ({
    id: model.id,
    displayName: model.display_name,
    provider: "anthropic" as const,
    createdAt: model.created_at,
  }));
}

/**
 * Fetch models from OpenAI API
 */
async function fetchOpenAiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.openai.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch OpenAI models",
    );
    throw new Error(`Failed to fetch OpenAI models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: (OpenAi.Types.Model | OpenAi.Types.OrlandoModel)[];
  };
  const excludePatterns = [
    "instruct",
    "embedding",
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

      // Must not contain excluded patterns
      const hasExcludedPattern = excludePatterns.some((pattern) =>
        id.includes(pattern),
      );
      return !hasExcludedPattern;
    })
    .map(mapOpenAiModelToModelInfo);
}

export function mapOpenAiModelToModelInfo(
  model: OpenAi.Types.Model | OpenAi.Types.OrlandoModel,
): ModelInfo {
  // by default it's openai
  let provider: SupportedProvider = "openai";
  // but if it's an orlando model (we identify that by missing owned_by property)
  if (!("owned_by" in model)) {
    // then we need to determine the provider based on the model id (falling back to default openai)
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

/**
 * Fetch models from Gemini API (Google AI Studio - API key mode)
 */
export async function fetchGeminiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.gemini.baseUrl;
  const url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Gemini models",
    );
    throw new Error(`Failed to fetch Gemini models: ${response.status}`);
  }

  const data = (await response.json()) as {
    models: Gemini.Types.Model[];
  };

  // Filter to only models that support generateContent (chat)
  return data.models
    .filter(
      (model) =>
        model.supportedGenerationMethods?.includes("generateContent") ?? false,
    )
    .map((model) => {
      // Model name is in format "models/gemini-1.5-flash-001", extract just the model ID
      const modelId = model.name.replace("models/", "");
      return {
        id: modelId,
        displayName: model.displayName ?? modelId,
        provider: "gemini" as const,
      };
    });
}

/**
 * Fetch models from Cerebras API (OpenAI-compatible)
 * Note: Llama models are excluded as they are not allowed in chat
 */
async function fetchCerebrasModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cerebras.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Cerebras models",
    );
    throw new Error(`Failed to fetch Cerebras models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created: number;
      owned_by: string;
    }>;
  };

  // Filter out Llama models - they are not allowed in chat for Cerebras provider
  return data.data
    .filter((model) => !model.id.toLowerCase().includes("llama"))
    .map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: "cerebras" as const,
      createdAt: new Date(model.created * 1000).toISOString(),
    }));
}

/**
 * Fetch models from Mistral API (OpenAI-compatible)
 */
async function fetchMistralModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.mistral.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Mistral models",
    );
    throw new Error(`Failed to fetch Mistral models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created: number;
      owned_by: string;
    }>;
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "mistral" as const,
    createdAt: new Date(model.created * 1000).toISOString(),
  }));
}

/**
 * Fetch models from Perplexity API
 *
 * Note: Perplexity does NOT have a /models endpoint like OpenAI.
 * Returns a hardcoded list of available models. Perplexity does not have a
 * /models endpoint, so we return the known models directly. API key validation
 * happens on first actual use rather than on model list refresh.
 *
 * @see https://docs.perplexity.ai/models/model-cards
 */
async function fetchPerplexityModels(
  _apiKey: string,
  _baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  // Perplexity has no /models endpoint - validation happens on first actual use.
  // Model list centralized in shared/model-constants.ts (PERPLEXITY_MODELS).
  return PERPLEXITY_MODELS.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    provider: "perplexity" as const,
  }));
}

/**
 * Fetch models from Groq API (OpenAI-compatible)
 * @see https://console.groq.com/docs/api-reference
 */
async function fetchGroqModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.groq.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Groq models",
    );
    throw new Error(`Failed to fetch Groq models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created: number;
      owned_by: string;
    }>;
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "groq" as const,
    createdAt: new Date(model.created * 1000).toISOString(),
  }));
}

/**
 * Fetch models from vLLM API
 * vLLM exposes an OpenAI-compatible /models endpoint
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */
async function fetchVllmModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.vllm.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      // vLLM typically doesn't require API keys, but pass it if provided
      Authorization: apiKey ? `Bearer ${apiKey}` : "Bearer EMPTY",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch vLLM models",
    );
    throw new Error(`Failed to fetch vLLM models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      object: string;
      created?: number;
      owned_by?: string;
      root?: string;
      parent?: string | null;
    }>;
  };

  // vLLM returns all loaded models, no filtering needed
  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "vllm" as const,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}

/**
 * Fetch models from Ollama API
 * Ollama exposes an OpenAI-compatible /models endpoint
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
async function fetchOllamaModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.ollama.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      // Ollama typically doesn't require API keys, but pass it if provided
      Authorization: apiKey ? `Bearer ${apiKey}` : "Bearer EMPTY",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Ollama models",
    );
    throw new Error(`Failed to fetch Ollama models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      object: string;
      created?: number;
      owned_by?: string;
    }>;
  };

  // Ollama returns all locally available models, no filtering needed
  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "ollama" as const,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}

/**
 * Fetch models from Cohere API
 */
async function fetchCohereModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.cohere.baseUrl;
  const url = `${baseUrl}/v2/models`;

  const response = await fetch(url, {
    headers: {
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

  // Only include models that expose chat/generate endpoints (exclude embed/rerank)
  const models = data.models
    .filter((model) => {
      const endpoints = model.endpoints || [];
      // accept models that support chat or generate
      return endpoints.includes("chat") || endpoints.includes("generate");
    })
    .map((model) => ({
      id: model.name,
      displayName: model.name,
      provider: "cohere" as const,
      createdAt: model.created_at,
    }));

  // Sort models to put command-r-08-2024 first (default choice)
  return models.sort((a, b) => {
    const preferredModel = "command-r-08-2024";
    if (a.id === preferredModel) return -1;
    if (b.id === preferredModel) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Fetch models from Zhipuai API
 */
async function fetchZhipuaiModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.zhipuai.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Zhipuai models",
    );
    throw new Error(`Failed to fetch Zhipuai models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      created: number;
      owned_by: string;
    }>;
  };

  // Filter to chat-compatible models
  // Include: glm-, chatglm- models (including vision variants)
  // Exclude: -embedding models only
  const chatModelPrefixes = ["glm-", "chatglm-"];
  const excludePatterns = ["-embedding"];

  const apiModels = data.data
    .filter((model) => {
      const id = model.id.toLowerCase();
      // Must start with a chat model prefix
      const hasValidPrefix = chatModelPrefixes.some((prefix) =>
        id.startsWith(prefix),
      );
      if (!hasValidPrefix) return false;

      // Must not contain excluded patterns
      const hasExcludedPattern = excludePatterns.some((pattern) =>
        id.includes(pattern),
      );
      return !hasExcludedPattern;
    })
    .map((model) => ({
      id: model.id,
      displayName: model.id,
      provider: "zhipuai" as const,
      createdAt: new Date(model.created * 1000).toISOString(),
    }));

  // Add common free/flash models that may not be listed in /models endpoint
  // These models are available for use but sometimes not returned by the API
  const freeModels: ModelInfo[] = [
    {
      id: "glm-4.5-flash",
      displayName: "glm-4.5-flash",
      provider: "zhipuai" as const,
      createdAt: new Date().toISOString(),
    },
  ];

  // Combine API models with free models, avoiding duplicates
  // Free models go first since they're the fastest/lightest
  const existingIds = new Set(apiModels.map((m) => m.id.toLowerCase()));
  const allModels = [];

  // Add free models first (they appear at the top)
  for (const freeModel of freeModels) {
    if (!existingIds.has(freeModel.id.toLowerCase())) {
      allModels.push(freeModel);
    }
  }

  // Then add API models
  allModels.push(...apiModels);

  return allModels;
}

async function fetchMinimaxModels(
  _apiKey: string,
  _baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  // MiniMax does not provide a /v1/models endpoint (returns 404)
  // Return known models directly. API key validation happens during actual chat completion requests.
  // Model list centralized in shared/model-constants.ts (MINIMAX_MODELS).
  return MINIMAX_MODELS.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    provider: "minimax" as const,
  }));
}

/**
 * Fetch models from DeepSeek API
 */
async function fetchDeepSeekModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.deepseek.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch DeepSeek models",
    );
    throw new Error(`Failed to fetch DeepSeek models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data?: Array<{
      id: string;
      created?: number;
      owned_by?: string;
    }>;
  };

  const list = Array.isArray(data?.data) ? data.data : [];
  return list.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "deepseek" as const,
    createdAt:
      model.created != null
        ? new Date(model.created * 1000).toISOString()
        : new Date(0).toISOString(),
  }));
}

/**
 * Fetch models from AWS Bedrock API
 * Uses Bearer token authentication (proxy handles AWS credentials)
 */
export async function fetchBedrockModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.bedrock.baseUrl;
  if (!baseUrl) {
    logger.warn("Bedrock base URL not configured");
    return [];
  }

  // Remove '-runtime' from base URL to get the control plane endpoint
  const url = `${baseUrl.replace("-runtime", "")}/foundation-models?byOutputModality=TEXT&byInputModality=TEXT`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Bedrock models",
    );
    throw new Error(`Failed to fetch Bedrock models: ${response.status}`);
  }

  const data = (await response.json()) as {
    modelSummaries?: Array<{
      modelId?: string;
      modelName?: string;
      providerName?: string;
      inferenceTypesSupported?: string[];
      inputModalities?: string[];
    }>;
  };

  logger.info(
    { url, modelCount: data.modelSummaries?.length, data },
    "[fetchBedrockModels] full response from Bedrock ListFoundationModels",
  );

  if (!data.modelSummaries) {
    logger.warn("No models returned from Bedrock ListFoundationModels");
    return [];
  }

  // Filter to include models that support on-demand or inference profile (cross-region)
  // INFERENCE_PROFILE models (like Claude) require the prefix env var to be set
  const inferenceProfilePrefix = config.llm.bedrock.inferenceProfilePrefix;

  const models = data.modelSummaries
    .filter((model) => {
      // Must support TEXT input modality
      if (!model.inputModalities?.includes("TEXT")) {
        return false;
      }

      const supportsOnDemand =
        model.inferenceTypesSupported?.includes("ON_DEMAND");
      const supportsInferenceProfile =
        model.inferenceTypesSupported?.includes("INFERENCE_PROFILE");

      // Include ON_DEMAND models always
      // Include INFERENCE_PROFILE models only if prefix is configured
      return (
        supportsOnDemand || (supportsInferenceProfile && inferenceProfilePrefix)
      );
    })
    .map((model) => {
      // Generate a readable display name
      const providerName = model.providerName || "Unknown";
      const modelName = model.modelName || model.modelId || "Unknown Model";
      const displayName = `${providerName} ${modelName}`;

      // For INFERENCE_PROFILE models, prefix with region (e.g., "us" or "eu")
      const isInferenceProfile =
        model.inferenceTypesSupported?.includes("INFERENCE_PROFILE");
      const prefix = inferenceProfilePrefix.endsWith(".")
        ? inferenceProfilePrefix
        : `${inferenceProfilePrefix}.`;
      const modelId =
        isInferenceProfile && inferenceProfilePrefix
          ? `${prefix}${model.modelId}`
          : model.modelId;

      return {
        id: modelId || "",
        displayName,
        provider: "bedrock" as const,
      };
    });

  logger.info(
    {
      modelCount: models.length,
      models: models.map((m) => ({ id: m.id, displayName: m.displayName })),
    },
    "[fetchBedrockModels] filtered models returned for bedrock",
  );

  return models;
}

/**
 * Fetch models from AWS Bedrock API via IAM credentials (IRSA, env vars, instance profile).
 * Uses SigV4 signing for authentication instead of API keys.
 * This is the Bedrock equivalent of fetchGeminiModelsViaVertexAi.
 */
export async function fetchBedrockModelsViaIam(): Promise<ModelInfo[]> {
  const baseUrl = config.llm.bedrock.baseUrl;
  if (!baseUrl) {
    logger.warn("Bedrock base URL not configured");
    return [];
  }

  const region = getBedrockRegion(baseUrl);
  const url = `${baseUrl.replace("-runtime", "")}/foundation-models?byOutputModality=TEXT&byInputModality=TEXT`;

  const creds = await getBedrockCredentialProvider()();

  const signer = new AwsV4Signer({
    url,
    method: "GET",
    region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    service: "bedrock",
  });

  const signed = await signer.sign();
  const response = await fetch(signed.url, { headers: signed.headers });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch Bedrock models via IAM",
    );
    throw new Error(
      `Failed to fetch Bedrock models via IAM: ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    modelSummaries?: Array<{
      modelId?: string;
      modelName?: string;
      providerName?: string;
      inferenceTypesSupported?: string[];
      inputModalities?: string[];
    }>;
  };

  if (!data.modelSummaries) {
    logger.warn("No models returned from Bedrock ListFoundationModels via IAM");
    return [];
  }

  const inferenceProfilePrefix = config.llm.bedrock.inferenceProfilePrefix;

  const models = data.modelSummaries
    .filter((model) => {
      if (!model.inputModalities?.includes("TEXT")) return false;
      const supportsOnDemand =
        model.inferenceTypesSupported?.includes("ON_DEMAND");
      const supportsInferenceProfile =
        model.inferenceTypesSupported?.includes("INFERENCE_PROFILE");
      return (
        supportsOnDemand || (supportsInferenceProfile && inferenceProfilePrefix)
      );
    })
    .map((model) => {
      const providerName = model.providerName || "Unknown";
      const modelName = model.modelName || model.modelId || "Unknown Model";
      const displayName = `${providerName} ${modelName}`;
      const isInferenceProfile =
        model.inferenceTypesSupported?.includes("INFERENCE_PROFILE");
      const prefix = inferenceProfilePrefix.endsWith(".")
        ? inferenceProfilePrefix
        : `${inferenceProfilePrefix}.`;
      const modelId =
        isInferenceProfile && inferenceProfilePrefix
          ? `${prefix}${model.modelId}`
          : model.modelId;
      return {
        id: modelId || "",
        displayName,
        provider: "bedrock" as const,
      };
    });

  logger.info(
    { modelCount: models.length },
    "[fetchBedrockModelsViaIam] fetched models",
  );

  return models;
}

/**
 * Fetch models from OpenRouter API (OpenAI-compatible)
 */
async function fetchOpenrouterModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.openrouter.baseUrl;
  const url = `${baseUrl}/models`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      "Failed to fetch OpenRouter models",
    );
    throw new Error(`Failed to fetch OpenRouter models: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ id: string; created?: number }>;
  };

  return data.data.map((model) => ({
    id: model.id,
    displayName: model.id,
    provider: "openrouter" as const,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  }));
}

/**
 * Fetch models from Gemini API via Vertex AI SDK
 * Uses Application Default Credentials (ADC) for authentication
 *
 * Note: Vertex AI returns models in a different format than Google AI Studio:
 * - Model names are "publishers/google/models/xxx" not "models/xxx"
 * - No supportedActions or displayName fields available
 * - We filter by model name pattern to get chat-capable Gemini models
 *
 * This function is cached globally since Vertex AI models are the same for all users
 * (authentication is via ADC, not user-specific API keys)
 */
export async function fetchGeminiModelsViaVertexAi(): Promise<ModelInfo[]> {
  logger.debug(
    {
      project: config.llm.gemini.vertexAi.project,
      location: config.llm.gemini.vertexAi.location,
    },
    "Fetching Gemini models via Vertex AI SDK",
  );

  // Create a client without API key (uses ADC for Vertex AI)
  const ai = createGoogleGenAIClient(undefined, "[ChatModels]");

  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const discoveredModels: ModelInfo[] = [];

  for await (const model of pager) {
    const modelInfo = extractVertexGeminiModel(model);
    if (modelInfo) {
      discoveredModels.push(modelInfo);
    }
  }

  logger.debug(
    { modelCount: discoveredModels.length },
    "Fetched Gemini models via Vertex AI SDK",
  );

  const fallbackModels = await fetchVertexGeminiFallbackModels({
    ai,
    existingModelIds: new Set(discoveredModels.map((model) => model.id)),
    shouldRunFallback:
      discoveredModels.length === 0 ||
      !discoveredModels.some((model) => isPrimaryVertexGeminiModel(model.id)),
  });

  return dedupeModelsById([...discoveredModels, ...fallbackModels]);
}

/**
 * Get API key for a provider using resolution priority: personal → team → org_wide → env
 */
async function getProviderApiKey({
  provider,
  organizationId,
  userId,
  userTeamIds,
}: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<string | null> {
  const apiKey = await ChatApiKeyModel.getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds,
    provider,
    // set null to autoresolve the api key
    conversationId: null,
  });

  if (apiKey?.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      apiKey.secretId,
    );

    if (secretValue) {
      return secretValue as string;
    }
  }

  // Fall back to environment variable
  return getProviderEnvApiKey(provider) ?? null;
}

// We need to make sure that every new provider we support has a model fetcher function
const modelFetchers: Record<
  SupportedProvider,
  (apiKey: string, baseUrl?: string | null) => Promise<ModelInfo[]>
> = {
  anthropic: fetchAnthropicModels,
  bedrock: fetchBedrockModels,
  cerebras: fetchCerebrasModels,
  gemini: fetchGeminiModels,
  mistral: fetchMistralModels,
  openai: fetchOpenAiModels,
  openrouter: fetchOpenrouterModels,
  perplexity: fetchPerplexityModels,
  groq: fetchGroqModels,
  xai: fetchXaiModels,
  vllm: fetchVllmModels,
  ollama: fetchOllamaModels,
  cohere: fetchCohereModels,
  zhipuai: fetchZhipuaiModels,
  minimax: fetchMinimaxModels,
  deepseek: fetchDeepSeekModels,
};

// Register all model fetchers with the sync service
for (const [provider, fetcher] of Object.entries(modelFetchers)) {
  modelSyncService.registerFetcher(provider as SupportedProvider, fetcher);
}

/**
 * Test if an API key is valid by attempting to fetch models from the provider.
 * Throws an error if the key is invalid or the provider is unreachable.
 */
export async function testProviderApiKey(
  provider: SupportedProvider,
  apiKey: string,
  baseUrl?: string | null,
): Promise<void> {
  await modelFetchers[provider](apiKey, baseUrl);
}

/**
 * Fetch models for a single provider
 */
export async function fetchModelsForProvider({
  provider,
  organizationId,
  userId,
  userTeamIds,
}: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<ModelInfo[]> {
  const apiKey = await getProviderApiKey({
    provider,
    organizationId,
    userId,
    userTeamIds,
  });

  // Gemini with Vertex AI uses ADC instead of API keys
  const vertexAiEnabled = provider === "gemini" && isVertexAiEnabled();

  // Bedrock with IAM auth uses AWS credential chain instead of API keys
  const bedrockIamEnabled = provider === "bedrock" && isBedrockIamAuthEnabled();

  // Some providers don't require API keys but need base URL configured
  const isKeylessProviderEnabled =
    (provider === "vllm" && config.llm.vllm.enabled) ||
    (provider === "ollama" && config.llm.ollama.enabled);

  // Bedrock uses AWS credentials which may come from default credential chain
  const isBedrockEnabled = provider === "bedrock" && config.llm.bedrock.enabled;

  if (
    !apiKey &&
    !vertexAiEnabled &&
    !bedrockIamEnabled &&
    !isKeylessProviderEnabled &&
    !isBedrockEnabled
  ) {
    logger.debug(
      { provider, organizationId },
      "No API key available for provider",
    );
    return [];
  }

  try {
    let models: ModelInfo[];

    if (provider === "gemini" && vertexAiEnabled) {
      // Vertex AI uses ADC for authentication, not API keys
      models = await fetchGeminiModelsViaVertexAi();
    } else if (provider === "bedrock" && bedrockIamEnabled) {
      // Bedrock with IAM uses AWS credential chain, not API keys
      models = await fetchBedrockModelsViaIam();
    } else {
      // All other providers use the standard model fetcher with an API key
      // (keyless providers like vLLM/Ollama/MiniMax/Perplexity pass "EMPTY" as a placeholder)
      models = await modelFetchers[provider](apiKey || "EMPTY");
    }

    logger.info(
      { provider, modelCount: models.length },
      "fetchModelsForProvider:fetched models from provider",
    );
    return models;
  } catch (error) {
    logger.error(
      {
        provider,
        organizationId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "fetchModelsForProvider:error fetching models from provider",
    );
    return [];
  }
}

const chatModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get available models from all configured providers
  fastify.get(
    "/api/chat/models",
    {
      schema: {
        operationId: RouteId.GetChatModels,
        description:
          "Get available LLM models from all configured providers. Models are fetched directly from provider APIs. Includes model capabilities (context length, modalities, tool calling support) when available.",
        tags: ["Chat"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          apiKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(z.array(ChatModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const { provider, apiKeyId } = query;

      // Trigger models.dev metadata sync in background if needed
      modelsDevClient.syncIfNeeded();

      // Get user's accessible API keys
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
        provider,
      );

      logger.info(
        {
          organizationId,
          provider,
          apiKeyId,
          apiKeyCount: apiKeys.length,
          apiKeys: apiKeys.map((k) => ({
            id: k.id,
            name: k.name,
            provider: k.provider,
            isSystem: k.isSystem,
          })),
        },
        "Available API keys for user",
      );

      // Get models from database based on user's API keys
      // If a specific apiKeyId is provided and it's in the user's accessible keys,
      // only return models for that key
      const accessibleKeyIds = apiKeys.map((k) => k.id);
      if (apiKeyId && !accessibleKeyIds.includes(apiKeyId)) {
        logger.warn(
          { apiKeyId, organizationId, userId: user.id },
          "Requested apiKeyId not found in user's accessible keys, falling back to all keys",
        );
      }
      const apiKeyIds =
        apiKeyId && accessibleKeyIds.includes(apiKeyId)
          ? [apiKeyId]
          : accessibleKeyIds;
      const dbModels = await ApiKeyModelModel.getModelsForApiKeyIds(apiKeyIds);

      logger.info(
        {
          organizationId,
          provider,
          apiKeyIds,
          modelCount: dbModels.length,
        },
        "Models fetched from database",
      );

      // Filter by provider if specified
      const filteredModels = provider
        ? dbModels.filter((m) => m.model.provider === provider)
        : dbModels;

      // Transform to response format with capabilities and markers
      const models = filteredModels.map(({ model, isBest, isFastest }) => ({
        id: model.modelId,
        displayName: model.description || model.modelId,
        provider: model.provider,
        capabilities: ModelModel.toCapabilities(model),
        isBest,
        isFastest,
      }));

      logger.info(
        { organizationId, provider, totalModels: models.length },
        "Returning chat models from database",
      );

      return reply.send(models);
    },
  );

  // Sync models from providers for all API keys
  fastify.post(
    "/api/chat/models/sync",
    {
      schema: {
        operationId: RouteId.SyncChatModels,
        description:
          "Sync models from providers for all API keys and store them in the database",
        tags: ["Chat"],
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Sync models for all API keys visible to the user
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
      );

      // Fetch secret values and sync models for each API key
      const syncPromises = apiKeys.map(async (apiKey) => {
        let secretValue: string | null = null;

        if (apiKey.secretId) {
          secretValue = (await getSecretValueForLlmProviderApiKey(
            apiKey.secretId,
          )) as string | null;
        }

        if (
          !secretValue &&
          !PROVIDERS_WITH_OPTIONAL_API_KEY.has(apiKey.provider)
        ) {
          if (apiKey.secretId) {
            logger.warn(
              { apiKeyId: apiKey.id, provider: apiKey.provider },
              "No secret value for API key, skipping sync",
            );
          }
          return;
        }

        try {
          await modelSyncService.syncModelsForApiKey({
            apiKeyId: apiKey.id,
            provider: apiKey.provider,
            apiKeyValue: secretValue ?? "",
            baseUrl: apiKey.baseUrl,
          });
        } catch (error) {
          logger.error(
            {
              apiKeyId: apiKey.id,
              provider: apiKey.provider,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to sync models for API key",
          );
        }
      });

      await Promise.all(syncPromises);

      // Also sync system keys for keyless providers (Vertex AI, vLLM, Ollama, Bedrock)
      await systemKeyManager.syncSystemKeys(organizationId);

      logger.info(
        { organizationId, apiKeyCount: apiKeys.length },
        "Completed model sync for all API keys (including system keys)",
      );

      return reply.send({ success: true });
    },
  );

  // Full sync: re-fetch models and overwrite ALL fields including user-edited values
  fastify.post(
    "/api/chat/models/sync-full",
    {
      schema: {
        operationId: RouteId.SyncChatModelsFull,
        description:
          "Sync models from providers, overwriting all fields including custom modifications",
        tags: ["Chat"],
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, user }, reply) => {
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const apiKeys = await ChatApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
      );

      const syncPromises = apiKeys.map(async (apiKey) => {
        let secretValue: string | null = null;

        if (apiKey.secretId) {
          secretValue = (await getSecretValueForLlmProviderApiKey(
            apiKey.secretId,
          )) as string | null;
        }

        if (
          !secretValue &&
          !PROVIDERS_WITH_OPTIONAL_API_KEY.has(apiKey.provider)
        ) {
          if (apiKey.secretId) {
            logger.warn(
              { apiKeyId: apiKey.id, provider: apiKey.provider },
              "No secret value for API key, skipping sync",
            );
          }
          return;
        }

        try {
          await modelSyncService.syncModelsForApiKey({
            apiKeyId: apiKey.id,
            provider: apiKey.provider,
            apiKeyValue: secretValue ?? "",
            baseUrl: apiKey.baseUrl,
            forceRefresh: true,
          });
        } catch (error) {
          logger.error(
            {
              apiKeyId: apiKey.id,
              provider: apiKey.provider,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to full-sync models for API key",
          );
        }
      });

      await Promise.all(syncPromises);

      await systemKeyManager.syncSystemKeys(organizationId);

      logger.info(
        { organizationId, apiKeyCount: apiKeys.length },
        "Completed full model sync for all API keys (including system keys)",
      );

      return reply.send({ success: true });
    },
  );

  // Get all models with their linked API keys for the settings page
  fastify.get(
    "/api/models",
    {
      schema: {
        operationId: RouteId.GetModelsWithApiKeys,
        description:
          "Get all models with their linked API keys. Returns models from the database with information about which API keys provide access to them.",
        tags: ["Models"],
        response: constructResponseSchema(z.array(ModelWithApiKeysSchema)),
      },
    },
    async (_, reply) => {
      // Get models with their API key relationships.
      // Only returns models that have at least one linked API key.
      const modelsWithApiKeys =
        await ApiKeyModelModel.getAllModelsWithApiKeys();

      // Also include LLM Proxy-discovered models even without API key links.
      // These models are discovered during proxy requests and preserved so users
      // can define custom token pricing for metrics.
      const linkedModelIds = new Set(modelsWithApiKeys.map((m) => m.model.id));
      const llmProxyModels = await ModelModel.findLlmProxyModels();
      const unlinkedLlmProxyModels = llmProxyModels.filter(
        (m) => !linkedModelIds.has(m.id),
      );

      // Transform to response format with capabilities and markers
      const response = [
        ...modelsWithApiKeys.map(({ model, isFastest, isBest, apiKeys }) => ({
          ...model,
          isFastest,
          isBest,
          apiKeys,
          capabilities: ModelModel.toCapabilities(model),
        })),
        ...unlinkedLlmProxyModels.map((model) => ({
          ...model,
          isFastest: false,
          isBest: false,
          apiKeys: [],
          capabilities: ModelModel.toCapabilities(model),
        })),
      ];

      logger.debug(
        { modelCount: response.length },
        "Returning models with API keys",
      );

      return reply.send(response);
    },
  );

  // Update model details (pricing + modalities)
  fastify.patch(
    "/api/models/:id",
    {
      schema: {
        operationId: RouteId.UpdateModel,
        description:
          "Update model details including custom pricing and modalities.",
        tags: ["Models"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: PatchModelBodySchema,
        response: constructResponseSchema(SelectModelSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const existing = await ModelModel.findById(id);
      if (!existing) {
        throw new ApiError(404, "Model not found");
      }

      const updated = await ModelModel.update(id, body);
      if (!updated) {
        throw new ApiError(500, "Failed to update model");
      }

      return reply.send(updated);
    },
  );
};

const VERTEX_GEMINI_EXCLUDE_PATTERNS = [
  "embedding",
  "imagen",
  "text-bison",
  "code-bison",
];

const VERTEX_GEMINI_FALLBACK_MODEL_IDS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001",
  "gemini-1.5-pro-002",
  "gemini-1.5-flash-002",
];

function extractVertexGeminiModel(model: {
  name?: string | null;
  displayName?: string | null;
}): ModelInfo | null {
  const modelName = model.name ?? "";
  if (!modelName.includes("gemini")) {
    return null;
  }

  const lowerModelName = modelName.toLowerCase();
  const isExcluded = VERTEX_GEMINI_EXCLUDE_PATTERNS.some((pattern) =>
    lowerModelName.includes(pattern),
  );
  if (isExcluded) {
    return null;
  }

  const modelId = modelName.replace("publishers/google/models/", "");
  return {
    id: modelId,
    displayName: model.displayName ?? formatVertexGeminiDisplayName(modelId),
    provider: "gemini",
  };
}

async function fetchVertexGeminiFallbackModels(params: {
  ai: ReturnType<typeof createGoogleGenAIClient>;
  existingModelIds: Set<string>;
  shouldRunFallback: boolean;
}): Promise<ModelInfo[]> {
  const { ai, existingModelIds, shouldRunFallback } = params;
  if (!shouldRunFallback) {
    return [];
  }

  const candidateModelIds = VERTEX_GEMINI_FALLBACK_MODEL_IDS.filter(
    (modelId) => !existingModelIds.has(modelId),
  );

  logger.info(
    { candidateCount: candidateModelIds.length },
    "Vertex AI model list returned incomplete Gemini results, probing fallback model IDs",
  );

  const results = await Promise.allSettled(
    candidateModelIds.map(async (modelId) => {
      const model = await ai.models.get({ model: modelId });
      return extractVertexGeminiModel({
        name: model.name,
        displayName: model.displayName,
      });
    }),
  );

  const validatedModels: ModelInfo[] = [];
  for (const [index, result] of results.entries()) {
    const modelId = candidateModelIds[index];

    if (result.status === "fulfilled") {
      if (result.value) {
        validatedModels.push(result.value);
      }
      continue;
    }

    logger.debug(
      {
        modelId,
        errorMessage:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      },
      "Vertex AI Gemini fallback candidate unavailable",
    );
  }

  logger.info(
    { validatedCount: validatedModels.length },
    "Validated Vertex AI Gemini fallback models",
  );

  return validatedModels;
}

function dedupeModelsById(models: ModelInfo[]): ModelInfo[] {
  const deduped = new Map<string, ModelInfo>();
  for (const model of models) {
    deduped.set(model.id, model);
  }
  return [...deduped.values()];
}

function formatVertexGeminiDisplayName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isPrimaryVertexGeminiModel(modelId: string): boolean {
  return modelId.includes("flash") || modelId.includes("pro");
}

export default chatModelsRoutes;
