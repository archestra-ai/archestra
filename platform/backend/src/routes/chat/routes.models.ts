import {
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  RouteId,
  type SupportedProvider,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
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
  constructResponseSchema,
  type Gemini,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  ModelWithApiKeysSchema,
  type OpenAi,
  SupportedChatProviderSchema,
} from "@/types";

// Response schema for models
const ChatModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedChatProviderSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
});

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
  capabilities?: ModelCapabilities;
}

/**
 * Fetch models from Anthropic API
 */
async function fetchAnthropicModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.anthropic.baseUrl;
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
async function fetchOpenAiModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.openai.baseUrl;
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
export async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.gemini.baseUrl;
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
async function fetchCerebrasModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.cerebras.baseUrl;
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
async function fetchMistralModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.mistral.baseUrl;
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
 * Fetch models from vLLM API
 * vLLM exposes an OpenAI-compatible /models endpoint
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */
async function fetchVllmModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.vllm.baseUrl;
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
async function fetchOllamaModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.ollama.baseUrl;
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
async function fetchCohereModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.cohere.baseUrl;
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
async function fetchZhipuaiModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.zhipuai.baseUrl;
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

/**
 * Fetch models from AWS Bedrock API
 * Uses Bearer token authentication (proxy handles AWS credentials)
 */
export async function fetchBedrockModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.llm.bedrock.baseUrl;
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

  const models: ModelInfo[] = [];

  // Patterns to exclude non-chat models
  const excludePatterns = ["embedding", "imagen", "text-bison", "code-bison"];

  for await (const model of pager) {
    const modelName = model.name ?? "";

    // Only include Gemini models that are chat-capable
    // Vertex AI returns names like "publishers/google/models/gemini-2.0-flash-001"
    if (!modelName.includes("gemini")) {
      continue;
    }

    // Exclude embedding and other non-chat models
    const isExcluded = excludePatterns.some((pattern) =>
      modelName.toLowerCase().includes(pattern),
    );
    if (isExcluded) {
      continue;
    }

    // Extract model ID from "publishers/google/models/gemini-xxx" format
    const modelId = modelName.replace("publishers/google/models/", "");

    // Generate a readable display name from the model ID
    // e.g., "gemini-2.0-flash-001" -> "Gemini 2.0 Flash 001"
    const displayName = modelId
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");

    models.push({
      id: modelId,
      displayName,
      provider: "gemini" as const,
    });
  }

  logger.debug(
    { modelCount: models.length },
    "Fetched Gemini models via Vertex AI SDK",
  );

  return models;
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
  // Using Record<SupportedProvider, ...> ensures TypeScript will error if a new provider is added
  // but not included in this map. This prevents missing API key fallbacks for new providers.
  const envApiKeyFallbacks: Record<SupportedProvider, () => string | null> = {
    anthropic: () => config.chat.anthropic.apiKey || null,
    cerebras: () => config.chat.cerebras.apiKey || null,
    cohere: () => config.chat.cohere?.apiKey || null,
    gemini: () => config.chat.gemini.apiKey || null,
    mistral: () => config.chat.mistral.apiKey || null,
    ollama: () => config.chat.ollama.apiKey || "", // Ollama typically doesn't require API keys
    openai: () => config.chat.openai.apiKey || null,
    vllm: () => config.chat.vllm.apiKey || "", // vLLM typically doesn't require API keys
    zhipuai: () => config.chat.zhipuai?.apiKey || null,
    bedrock: () => config.chat.bedrock.apiKey || null,
  };

  return envApiKeyFallbacks[provider]();
}

// We need to make sure that every new provider we support has a model fetcher function
const modelFetchers: Record<
  SupportedProvider,
  (apiKey: string) => Promise<ModelInfo[]>
> = {
  anthropic: fetchAnthropicModels,
  bedrock: fetchBedrockModels,
  cerebras: fetchCerebrasModels,
  gemini: fetchGeminiModels,
  mistral: fetchMistralModels,
  openai: fetchOpenAiModels,
  vllm: fetchVllmModels,
  ollama: fetchOllamaModels,
  cohere: fetchCohereModels,
  zhipuai: fetchZhipuaiModels,
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
): Promise<void> {
  await modelFetchers[provider](apiKey);
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

  const vertexAiEnabled = provider === "gemini" && isVertexAiEnabled();
  // vLLM and Ollama typically don't require API keys, but need base URL configured
  const isVllmEnabled = provider === "vllm" && config.llm.vllm.enabled;
  const isOllamaEnabled = provider === "ollama" && config.llm.ollama.enabled;
  // Bedrock uses AWS credentials which may come from default credential chain
  const isBedrockEnabled = provider === "bedrock" && config.llm.bedrock.enabled;

  // For Gemini with Vertex AI, we don't need an API key - authentication is via ADC
  // For vLLM and Ollama, API key is optional but base URL must be configured
  // For Bedrock, we check if it's enabled (may use default AWS credential chain)
  if (
    !apiKey &&
    !vertexAiEnabled &&
    !isVllmEnabled &&
    !isOllamaEnabled &&
    !isBedrockEnabled
  ) {
    logger.debug(
      { provider, organizationId },
      "No API key available for provider",
    );
    return [];
  }

  try {
    let models: ModelInfo[] = [];
    if (
      ["anthropic", "cerebras", "cohere", "mistral", "openai"].includes(
        provider,
      )
    ) {
      if (apiKey) {
        models = await modelFetchers[provider](apiKey);
      }
    } else if (provider === "gemini") {
      if (vertexAiEnabled) {
        // Use Vertex AI SDK for model listing (uses ADC for authentication)
        models = await fetchGeminiModelsViaVertexAi();
      } else if (apiKey) {
        // Use standard Gemini API with API key
        models = await modelFetchers[provider](apiKey);
      }
    } else if (provider === "vllm" && isVllmEnabled) {
      // vLLM doesn't require API key, pass empty or configured key
      models = await modelFetchers[provider](apiKey || "EMPTY");
    } else if (provider === "ollama" && isOllamaEnabled) {
      // Ollama doesn't require API key, pass empty or configured key
      models = await modelFetchers[provider](apiKey || "EMPTY");
    } else if (provider === "zhipuai") {
      if (apiKey) {
        models = await modelFetchers[provider](apiKey);
      }
    } else if (provider === "bedrock" && isBedrockEnabled) {
      // Bedrock uses AWS credentials via the proxy
      if (apiKey) {
        models = await modelFetchers[provider](apiKey);
      }
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
          provider: SupportedChatProviderSchema.optional(),
        }),
        response: constructResponseSchema(z.array(ChatModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const { provider } = query;

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
      const apiKeyIds = apiKeys.map((k) => k.id);
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
        ? dbModels.filter((m) => m.provider === provider)
        : dbModels;

      // Transform to response format with capabilities
      const models = filteredModels.map((model) => ({
        id: model.modelId,
        displayName: model.description || model.modelId,
        provider: model.provider,
        capabilities: ModelModel.toCapabilities(model),
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
          await modelSyncService.syncModelsForApiKey(
            apiKey.id,
            apiKey.provider,
            secretValue ?? "",
          );
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
      // Get all models with their API key relationships
      const modelsWithApiKeys =
        await ApiKeyModelModel.getAllModelsWithApiKeys();

      // Transform to response format with capabilities and markers
      const response = modelsWithApiKeys.map(
        ({ model, isFastest, isBest, apiKeys }) => ({
          ...model,
          isFastest,
          isBest,
          apiKeys,
          capabilities: ModelModel.toCapabilities(model),
        }),
      );

      logger.debug(
        { modelCount: response.length },
        "Returning models with API keys",
      );

      return reply.send(response);
    },
  );
};

export default chatModelsRoutes;
