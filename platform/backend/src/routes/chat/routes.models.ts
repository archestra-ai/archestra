import { RouteId, type SupportedProvider, SupportedProviders } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { uniqBy } from "lodash-es";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel, TeamModel } from "@/models";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/routes/proxy/utils/gemini-client";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import {
  type Anthropic,
  constructResponseSchema,
  type Gemini,
  type OpenAi,
  SupportedChatProviderSchema,
} from "@/types";

// Response schema for models
const ChatModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: SupportedChatProviderSchema,
  createdAt: z.string().optional(),
});

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
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
  const baseUrl = config.chat.cerebras.baseUrl;
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
 * Fetch models from Gemini API via Vertex AI SDK
 * Uses Application Default Credentials (ADC) for authentication
 *
 * Note: Vertex AI returns models in a different format than Google AI Studio:
 * - Model names are "publishers/google/models/xxx" not "models/xxx"
 * - No supportedActions or displayName fields available
 * - We filter by model name pattern to get chat-capable Gemini models
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
}: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
}): Promise<string | null> {
  const apiKey = await ChatApiKeyModel.getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds: await TeamModel.getUserTeamIds(userId),
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
  switch (provider) {
    case "anthropic":
      return config.chat.anthropic.apiKey || null;
    case "cerebras":
      return config.chat.cerebras.apiKey || null;
    case "gemini":
      return config.chat.gemini.apiKey || null;
    case "openai":
      return config.chat.openai.apiKey || null;
    case "vllm":
      // vLLM typically doesn't require API keys, return empty or configured key
      return config.chat.vllm.apiKey || "";
    case "ollama":
      // Ollama typically doesn't require API keys, return empty or configured key
      return config.chat.ollama.apiKey || "";
    default:
      return null;
  }
}

// We need to make sure that every new provider we support has a model fetcher function
const modelFetchers: Record<
  SupportedProvider,
  (apiKey: string) => Promise<ModelInfo[]>
> = {
  anthropic: fetchAnthropicModels,
  cerebras: fetchCerebrasModels,
  gemini: fetchGeminiModels,
  openai: fetchOpenAiModels,
  vllm: fetchVllmModels,
  ollama: fetchOllamaModels,
};

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
}: {
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
}): Promise<ModelInfo[]> {
  const apiKey = await getProviderApiKey({
    provider,
    organizationId,
    userId,
  });

  const vertexAiEnabled = provider === "gemini" && isVertexAiEnabled();
  // vLLM and Ollama typically don't require API keys
  const isVllm = provider === "vllm";
  const isOllama = provider === "ollama";

  // For Gemini with Vertex AI, we don't need an API key - authentication is via ADC
  // For vLLM and Ollama, API key is optional
  if (!apiKey && !vertexAiEnabled && !isVllm && !isOllama) {
    logger.debug(
      { provider, organizationId },
      "No API key available for provider",
    );
    return [];
  }

  try {
    let models: ModelInfo[] = [];
    if (["anthropic", "cerebras", "openai"].includes(provider)) {
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
    } else if (provider === "vllm") {
      // vLLM doesn't require API key, pass empty or configured key
      models = await modelFetchers[provider](apiKey || "EMPTY");
    } else if (provider === "ollama") {
      // Ollama doesn't require API key, pass empty or configured key
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
          "Get available LLM models from all configured providers. Models are fetched directly from provider APIs.",
        tags: ["Chat"],
        querystring: z.object({
          provider: SupportedChatProviderSchema.optional(),
        }),
        response: constructResponseSchema(z.array(ChatModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const { provider } = query;
      const providersToFetch = provider ? [provider] : SupportedProviders;

      const results = await Promise.all(
        providersToFetch.map((p) =>
          fetchModelsForProvider({
            provider: p as SupportedProvider,
            organizationId,
            userId: user.id,
          }),
        ),
      );

      const models = results.flat();

      logger.info(
        { organizationId, provider, modelCount: models.length },
        "Fetched and cached chat models",
      );

      logger.debug(
        { organizationId, provider, totalModels: models.length },
        "Returning chat models",
      );

      return reply.send(
        uniqBy(models, (model) => `${model.provider}:${model.id}`),
      );
    },
  );
};

export default chatModelsRoutes;
